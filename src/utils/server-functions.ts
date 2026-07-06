import {type ChildProcess, exec, spawn} from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {PodContext, ServerInstanceContext} from "../data-generator";
import type {LoggingOptions} from "../main";

export type AuthorizationMode = "no-auth" | "nondelegated" | "delegated";

let trackedServers: ServerInstanceContext[] = [];
const trackedProcesses = new Map<number, { child: ChildProcess; label: string }>();

function execCommand(command: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise(resolve => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        resolve({ stdout: "", stderr: stderr || error.message });
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function killProcessOnPort(port: number): Promise<void> {
  const { stdout, stderr } = await execCommand(`lsof -ti:${port}`);
  if (stderr) {
    return;
  }
  const pids = stdout.trim().split('\n')
    .filter(pid => pid)
    .filter(pid => pid !== String(process.pid) && pid !== String(process.ppid));
  if (pids.length === 0) {
    return;
  }
  const killResult = await execCommand(`kill ${pids.join(' ')}`);
  if (killResult.stderr) {
    console.error(`Stderr while killing processes on port ${port}: ${killResult.stderr}`);
  }
}

function runCommand(command: string, label: string, debug: boolean): ChildProcess {
  const child = spawn(command, {
    shell: true,
    stdio: 'pipe',
    detached: true,
    env: {
      ...process.env,
      GOCACHE: process.env.GOCACHE ?? "/tmp/query-aggregator-evaluation-go-build",
    },
  });
  let stderrBuffer = "";
  child.stdout?.on('data', (data: unknown) => {
    if (debug) {
      process.stdout.write(`[${label}] ${data as string}`);
    }
  });
  child.stderr?.on('data', (data: unknown) => {
    const text = String(data);
    stderrBuffer = (stderrBuffer + text).slice(-4000);
    if (debug) {
      process.stderr.write(`[${label}] ${data as string}`);
    }
  });
  child.on('error', (err) => {
    console.error(`[${label}] process error: ${err instanceof Error ? err.message : String(err)}`);
  });
  if (child.pid) {
    trackedProcesses.set(child.pid, { child, label });
  }
  child.on('exit', (code, signal) => {
    if (child.pid) {
      trackedProcesses.delete(child.pid);
    }
    if (code && stderrBuffer.trim()) {
      console.error(`[${label}] stderr before exit:\n${stderrBuffer.trim()}`);
    }
  });
  return child;
}

async function stopTrackedProcesses(): Promise<void> {
  const processes = Array.from(trackedProcesses.entries());
  trackedProcesses.clear();

  for (const [pid, { child, label }] of processes) {
    if (child.exitCode !== null || child.signalCode !== null) {
      continue;
    }
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore already exited processes.
      }
    }
  }

  await new Promise(resolve => setTimeout(resolve, 1000));
}

async function listSeededAccountsMissingPat(serverDataPath: string): Promise<string[]> {
  const accountsDataDir = path.join(serverDataPath, ".internal", "accounts", "data");
  let files: string[];
  try {
    files = await fs.readdir(accountsDataDir);
  } catch {
    return [serverDataPath];
  }

  const accountFiles = files.filter(file => file.endsWith("$.json"));
  if (accountFiles.length === 0) {
    return [serverDataPath];
  }

  const missing: string[] = [];
  for (const file of accountFiles) {
    let account: { authzServer?: string; asToken?: unknown };
    try {
      const content = await fs.readFile(path.join(accountsDataDir, file), "utf8");
      account = JSON.parse(content).payload as { authzServer?: string; asToken?: unknown };
    } catch {
      missing.push(file);
      continue;
    }
    if (account.authzServer && !account.asToken) {
      missing.push(file);
    }
  }
  return missing;
}

async function waitForCssAuthBootstrap(dataLocation: string, servers: ServerInstanceContext[]): Promise<void> {
  const accountCounts = await Promise.all(servers.map(async server => {
    try {
      const files = await fs.readdir(path.join(dataLocation, server.relativePath, ".internal", "accounts", "data"));
      return files.filter(file => file.endsWith("$.json")).length;
    } catch {
      return 0;
    }
  }));
  const accountCount = accountCounts.reduce((sum, count) => sum + count, 0);
  const timeoutMs = Math.max(120_000, accountCount * 5_000);
  const deadline = Date.now() + timeoutMs;
  let missingByServer: Array<{ server: ServerInstanceContext; missing: string[] }> = [];

  while (Date.now() < deadline) {
    missingByServer = (await Promise.all(servers.map(async server => ({
      server,
      missing: await listSeededAccountsMissingPat(path.join(dataLocation, server.relativePath))
    })))).filter(result => result.missing.length > 0);

    if (missingByServer.length === 0) {
      return;
    }

    const missingCount = missingByServer.reduce((sum, result) => sum + result.missing.length, 0);
    console.log(`Waiting for CSS auth bootstrap to complete (${missingCount}/${accountCount} account(s) missing PAT)...`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  const sample = missingByServer
    .flatMap(result => result.missing.slice(0, 3).map(file => `${result.server.relativePath}/${file}`))
    .slice(0, 10)
    .join(", ");
  throw new Error(
    `Timed out while waiting ${timeoutMs}ms for CSS auth bootstrap to complete` +
    (sample ? `. Missing PAT sample: ${sample}` : "")
  );
}

async function pathExists(location: string): Promise<boolean> {
  try {
    await fs.access(location);
    return true;
  } catch {
    return false;
  }
}

async function precompiledUmaAppIsCurrent(location: string): Promise<boolean> {
  try {
    const content = await fs.readFile(location, "utf8");
    return !content.includes(`backup${"FilePath"}`);
  } catch {
    return false;
  }
}

export async function stopServers(servers: ServerInstanceContext[] = trackedServers): Promise<void> {
  await stopTrackedProcesses();
  await killProcessOnPort(5000); // aggregator port
  await Promise.all(servers.flatMap(server => [
    killProcessOnPort(server.umaPort),
    killProcessOnPort(server.solidPort)
  ]));
}

export async function startServers(
  umaLocation: string,
  cssLocation: string,
  aggregatorLocation: string,
  dataLocation: string,
  authorizationMode: AuthorizationMode,
  servers: ServerInstanceContext[],
  queryUser: PodContext,
  loggingOptions?: LoggingOptions,
  resourceRegistrationAuthorizedWebId?: string
): Promise<void> {
  trackedServers = servers;

  await stopTrackedProcesses();
  await killProcessOnPort(5000);
  await Promise.all(servers.flatMap(server => [
    killProcessOnPort(server.umaPort),
    killProcessOnPort(server.solidPort)
  ]));
  await new Promise(resolve => setTimeout(resolve, 1000));

  for (const server of servers) {
    const umaLogLevel = loggingOptions?.uma ?? 'error';
    const umaConfigLocation = authorizationMode === "no-auth"
      ? "./config/no-auth.json"
      : authorizationMode === "nondelegated"
        ? "./config/nondelegated.json"
        : "./config/delegated.json";
    const authorizedWebId = resourceRegistrationAuthorizedWebId?.trim() || queryUser.webId;
    const authorizedWebIdOption = authorizationMode !== "no-auth"
      ? ` --resourceRegistrationAuthorizedWebId "${authorizedWebId}"`
      : "";
    const umaPrecompiledEntry = path.join(umaLocation, "bin", "main-precompiled.js");
    const umaPrecompiledApp = path.join(umaLocation, "dist", "precompiled", `app-${authorizationMode}.js`);
    const umaEntry = await pathExists(umaPrecompiledEntry) &&
      await pathExists(umaPrecompiledApp) &&
      await precompiledUmaAppIsCurrent(umaPrecompiledApp)
      ? `${umaLocation}/bin/main-precompiled.js --mode ${authorizationMode}`
      : `${umaLocation}/bin/main.js`;
    const command = `cd ${umaLocation} && node ${umaEntry} --port ${server.umaPort} --config-location ${umaConfigLocation} --base-url ${server.umaBaseUrl} --policy-base ${server.solidBaseUrl} --log-level ${umaLogLevel}${authorizedWebIdOption}`;
    runCommand(command, `UMA-${server.index}`, loggingOptions?.uma !== undefined);
  }

  console.log("waiting 1 seconds before starting CSS servers...");
  await new Promise(resolve => setTimeout(resolve, 1000));

  const cssConfigLocation = authorizationMode === "no-auth"
    ? "./config/no-auth.json"
    : "./config/default.json";
  const cssPatConfigLocation = authorizationMode === "no-auth"
    ? ""
    : " ./config/init-pat.json";

  for (const server of servers) {
    const serverDataPath = path.join(dataLocation, server.relativePath);
    const cssLogLevel = loggingOptions?.css ?? 'error';
    const cssPrecompiledEntry = path.join(cssLocation, "bin", "community-solid-server-precompiled.js");
    const cssPrecompiledApp = path.join(
      cssLocation,
      "dist",
      "precompiled",
      authorizationMode === "no-auth" ? "app-no-auth.js" : "app-auth.js"
    );
    const cssCommand = await pathExists(cssPrecompiledEntry) && await pathExists(cssPrecompiledApp)
      ? `node ./bin/community-solid-server-precompiled.js`
      : `yarn run community-solid-server`;
    const command = `cd "${cssLocation}" && ${cssCommand} -m . -c ${cssConfigLocation}${cssPatConfigLocation} --baseUrl ${server.solidBaseUrl} -f "${serverDataPath}" -p ${server.solidPort} -l ${cssLogLevel}`;
    runCommand(command, `CSS-${server.index}`, loggingOptions?.css !== undefined);
  }

  console.log("waiting 1 seconds before starting aggregator...");
  await new Promise(resolve => setTimeout(resolve, 1000));

  const queryUserWebId = `${queryUser.baseUrl}/profile/card#me`;
  const cssReadyDeadline = Date.now() + 120_000;
  while (Date.now() < cssReadyDeadline) {
    let allServersUp = true;
    for (const server of servers) {
      try {
        const response = await fetch(`${server.solidBaseUrl}/.well-known/solid`);
        if (!response.ok) {
          allServersUp = false;
          break;
        }
      } catch (e) {
        allServersUp = false;
        break;
      }
    }
    if (allServersUp) {
      break;
    }
    console.log("Waiting for CSS servers to be up...");
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (Date.now() >= cssReadyDeadline) {
    throw new Error("Timed out while waiting for CSS servers to be up");
  }

  if (authorizationMode !== "no-auth") {
    await waitForCssAuthBootstrap(dataLocation, servers);
  }

  console.log("Starting aggregator...");
  const aggregatorLogLevel = loggingOptions?.aggregator ?? 'error';
  const aggregatorCommand = `cd "${aggregatorLocation}" && go run . --webid ${queryUserWebId} --email ${queryUser.email} --password password --log-level ${aggregatorLogLevel}`;
  const aggregatorProcess = runCommand(aggregatorCommand, "AGGREGATOR", loggingOptions?.aggregator !== undefined);
  let aggregatorExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  aggregatorProcess.once('exit', (code, signal) => {
    aggregatorExit = { code, signal };
  });

  console.log("Waiting for aggregator to be up...");
  const aggregatorReadyDeadline = Date.now() + 120_000;
  while (Date.now() < aggregatorReadyDeadline) {
    if (aggregatorExit) {
      throw new Error(
        `Aggregator exited during startup with code ${aggregatorExit.code}` +
        `${aggregatorExit.signal ? ` (signal ${aggregatorExit.signal})` : ''}. ` +
        `Command was: ${aggregatorCommand}`
      );
    }

    try {
      const response = await fetch("http://localhost:5000/config", { method: "HEAD" });
      if (response.status < 500) {
        return;
      }
    } catch {
      // Keep polling until the listener is bound.
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw new Error(`Timed out while waiting for aggregator to be up. Command was: ${aggregatorCommand}`);
}
