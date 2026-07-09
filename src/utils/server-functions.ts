import {type ChildProcess, exec, spawn} from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {PodContext, ServerInstanceContext} from "../data-generator";
import type {LoggingOptions} from "../main";

export type AuthorizationMode = "no-auth" | "nondelegated" | "delegated";

let trackedServers: ServerInstanceContext[] = [];
const trackedProcesses = new Map<number, { child: ChildProcess; label: string }>();
const PORT_SHUTDOWN_TIMEOUT_MS = 10_000;
const PROCESS_SHUTDOWN_GRACE_MS = 2_000;
const SERVER_READY_LOG_TIMEOUT_MS = 120_000;
const UMA_READY_LOG_PREFIX = "QUERY_AGGREGATOR_EVALUATION_UMA_READY";
const CSS_READY_LOG_PREFIX = "QUERY_AGGREGATOR_EVALUATION_CSS_READY";
const CSS_PAT_READY_LOG_PREFIX = "QUERY_AGGREGATOR_EVALUATION_CSS_PAT_READY";
const AGGREGATOR_READY_LOG_PREFIX = "QUERY_AGGREGATOR_EVALUATION_AGGREGATOR_READY";

interface ManagedProcess {
  child: ChildProcess;
  waitForLog(marker: string, timeoutMs?: number): Promise<void>;
}

interface LogWaiter {
  marker: string;
  timeout: NodeJS.Timeout;
  resolve(): void;
  reject(error: Error): void;
}

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

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function listProcessIdsOnPort(port: number): Promise<number[]> {
  const { stdout, stderr } = await execCommand(`lsof -ti:${port}`);
  if (stderr) {
    return [];
  }
  return stdout.trim().split('\n')
    .filter(pid => pid)
    .map(pid => Number(pid))
    .filter(pid => Number.isInteger(pid) && pid > 0)
    .filter(pid => pid !== process.pid && pid !== process.ppid);
}

async function waitForPortToBeFree(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pids = await listProcessIdsOnPort(port);
    if (pids.length === 0) {
      return true;
    }
    await sleep(200);
  }
  return (await listProcessIdsOnPort(port)).length === 0;
}

async function killProcessOnPort(port: number): Promise<void> {
  const pids = await listProcessIdsOnPort(port);
  if (pids.length === 0) {
    return;
  }

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Ignore processes that have already exited.
    }
  }

  if (await waitForPortToBeFree(port, PORT_SHUTDOWN_TIMEOUT_MS)) {
    return;
  }

  const remainingPids = await listProcessIdsOnPort(port);
  for (const pid of remainingPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Ignore processes that have already exited.
    }
  }

  if (!await waitForPortToBeFree(port, PORT_SHUTDOWN_TIMEOUT_MS)) {
    console.error(`Port ${port} is still in use after killing process(es): ${remainingPids.join(", ")}`);
  }
}

function runCommand(command: string, label: string, debug: boolean): ManagedProcess {
  const child = spawn(command, {
    shell: true,
    stdio: 'pipe',
    detached: true,
    env: {
      ...process.env,
      GOCACHE: process.env.GOCACHE ?? "/tmp/query-aggregator-evaluation-go-build",
    },
  });
  const waiters: LogWaiter[] = [];
  let stdoutBuffer = "";
  let stderrBuffer = "";

  const resolveMatchingWaiters = () => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i];
      if (stdoutBuffer.includes(waiter.marker)) {
        clearTimeout(waiter.timeout);
        waiters.splice(i, 1);
        waiter.resolve();
      }
    }
  };

  child.stdout?.on('data', (data: unknown) => {
    const text = String(data);
    stdoutBuffer = (stdoutBuffer + text).slice(-16_000);
    resolveMatchingWaiters();
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
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error(
        `${label} exited before logging "${waiter.marker}"` +
        ` (code ${code}${signal ? `, signal ${signal}` : ""}).`
      ));
    }
    if (code && stderrBuffer.trim()) {
      console.error(`[${label}] stderr before exit:\n${stderrBuffer.trim()}`);
    }
  });
  return {
    child,
    waitForLog(marker: string, timeoutMs = SERVER_READY_LOG_TIMEOUT_MS): Promise<void> {
      if (stdoutBuffer.includes(marker)) {
        return Promise.resolve();
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        return Promise.reject(new Error(`${label} exited before logging "${marker}".`));
      }
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          const index = waiters.findIndex(waiter => waiter.marker === marker);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          reject(new Error(`Timed out while waiting for ${label} to log "${marker}".`));
        }, timeoutMs);
        waiters.push({ marker, timeout, resolve, reject });
      });
    },
  };
}

async function waitForProcessLogs(label: string, waits: Array<{ process: ManagedProcess; marker: string }>): Promise<void> {
  console.log(`Waiting for ${label} readiness logs (${waits.length} process(es))...`);
  await Promise.all(waits.map(wait => wait.process.waitForLog(wait.marker)));
  console.log(`✓ ${label} readiness logs received (${waits.length}/${waits.length} process(es)).`);
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

  const deadline = Date.now() + PROCESS_SHUTDOWN_GRACE_MS;
  while (Date.now() < deadline) {
    const runningProcesses = processes.filter(([, { child }]) => child.exitCode === null && child.signalCode === null);
    if (runningProcesses.length === 0) {
      return;
    }
    await sleep(100);
  }

  for (const [pid, { child }] of processes) {
    if (child.exitCode !== null || child.signalCode !== null) {
      continue;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore already exited processes.
      }
    }
  }

  await sleep(500);
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
  await sleep(1000);

  const umaWaits: Array<{ process: ManagedProcess; marker: string }> = [];
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
    const process = runCommand(command, `UMA-${server.index}`, loggingOptions?.uma !== undefined);
    umaWaits.push({
      process,
      marker: `${UMA_READY_LOG_PREFIX} port=${server.umaPort} baseUrl=${server.umaBaseUrl}`,
    });
  }

  await waitForProcessLogs("UMA server", umaWaits);

  const cssConfigLocation = authorizationMode === "no-auth"
    ? "./config/no-auth.json"
    : "./config/default.json";
  const cssPatConfigLocation = authorizationMode === "no-auth"
    ? ""
    : " ./config/init-pat.json";

  const cssWaits: Array<{ process: ManagedProcess; marker: string }> = [];
  const cssPatWaits: Array<{ process: ManagedProcess; marker: string }> = [];
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
    const process = runCommand(command, `CSS-${server.index}`, loggingOptions?.css !== undefined);
    cssWaits.push({
      process,
      marker: `${CSS_READY_LOG_PREFIX} port=${server.solidPort} baseUrl=${server.solidBaseUrl}`,
    });
    if (authorizationMode !== "no-auth") {
      cssPatWaits.push({
        process,
        marker: `${CSS_PAT_READY_LOG_PREFIX} rootFilePath=${serverDataPath}`,
      });
    }
  }

  await waitForProcessLogs("CSS server", cssWaits);
  if (cssPatWaits.length > 0) {
    await waitForProcessLogs("CSS PAT bootstrap", cssPatWaits);
  }

  const queryUserWebId = `${queryUser.baseUrl}/profile/card#me`;
  console.log("Starting aggregator...");
  const aggregatorLogLevel = loggingOptions?.aggregator ?? 'error';
  const aggregatorCommand = `cd "${aggregatorLocation}" && go run . --webid ${queryUserWebId} --email ${queryUser.email} --password password --log-level ${aggregatorLogLevel}`;
  const aggregatorProcess = runCommand(aggregatorCommand, "AGGREGATOR", loggingOptions?.aggregator !== undefined);
  await waitForProcessLogs("aggregator", [{
    process: aggregatorProcess,
    marker: `${AGGREGATOR_READY_LOG_PREFIX} port=5000 baseUrl=http://localhost:5000`,
  }]);
}
