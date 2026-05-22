import {type ChildProcess, exec, spawn} from "node:child_process";
import path from "node:path";
import {PodContext, ServerInstanceContext} from "../data-generator";
import type {LoggingOptions} from "../main";

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
  console.log(`Killing processes on port ${port}: ${pids.join(', ')}`);
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
    console.log(`[${label}] exited with code ${code}${signal ? ` (signal ${signal})` : ''}`);
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
    console.log(`[${label}] sent SIGTERM`);
  }

  await new Promise(resolve => setTimeout(resolve, 1000));
}

export async function stopServers(servers: ServerInstanceContext[] = trackedServers): Promise<void> {
  console.log("Stopping existing servers...");
  await stopTrackedProcesses();
  await killProcessOnPort(5000); // aggregator port
  await Promise.all(servers.flatMap(server => [
    killProcessOnPort(server.umaPort),
    killProcessOnPort(server.solidPort)
  ]));
  console.log("Server shutdown complete");
}

export async function startServers(
  umaLocation: string,
  cssLocation: string,
  aggregatorLocation: string,
  dataLocation: string,
  derivedAuth: boolean,
  servers: ServerInstanceContext[],
  queryUser: PodContext,
  loggingOptions?: LoggingOptions
): Promise<void> {
  trackedServers = servers;

  console.log("Cleaning up existing processes...");
  await stopTrackedProcesses();
  await killProcessOnPort(5000);
  await Promise.all(servers.flatMap(server => [
    killProcessOnPort(server.umaPort),
    killProcessOnPort(server.solidPort)
  ]));
  await new Promise(resolve => setTimeout(resolve, 1000));

  for (const server of servers) {
    console.log(`Starting UMA server-${server.index} on port ${server.umaPort}...`);
    const umaLogLevel = loggingOptions?.uma ?? 'error';
    const command = `cd ${umaLocation} && node ${umaLocation}/bin/main.js --port ${server.umaPort} --config-location ${derivedAuth? "./config/derivation.json" : "./config/default.json"} --base-url http://localhost:${server.umaPort}/uma --policy-base ${server.solidBaseUrl} --log-level ${umaLogLevel}`;
    runCommand(command, `UMA-${server.index}`, loggingOptions?.uma !== undefined);
  }

  console.log("waiting 2 seconds before starting CSS servers...");
  await new Promise(resolve => setTimeout(resolve, 2000));

  for (const server of servers) {
    console.log(`Starting CSS server-${server.index} on port ${server.solidPort}...`);
    const serverDataPath = path.join(dataLocation, server.relativePath);
    const cssLogLevel = loggingOptions?.css ?? 'error';
    const command = `cd "${cssLocation}" && yarn run community-solid-server -m . -c ./config/default.json -a ${server.umaBaseUrl} -f "${serverDataPath}" -p ${server.solidPort} -l ${cssLogLevel}`;
    runCommand(command, `CSS-${server.index}`, loggingOptions?.css !== undefined);
  }

  console.log("waiting 15 seconds before starting aggregator...");
  await new Promise(resolve => setTimeout(resolve, 15000));

  const queryUserWebId = `${queryUser.baseUrl}/profile/card#me`;
  while (true) {
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

  console.log("Starting aggregator...");
  const aggregatorLogLevel = loggingOptions?.aggregator ?? 'error';
  const aggregatorCommand = `cd "${aggregatorLocation}" && go run . --webid ${queryUserWebId} --email ${queryUser.email} --password password --log-level ${aggregatorLogLevel}`;
  const aggregatorProcess = runCommand(aggregatorCommand, "AGGREGATOR", loggingOptions?.aggregator !== undefined);
  let aggregatorExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  aggregatorProcess.once('exit', (code, signal) => {
    aggregatorExit = { code, signal };
  });

  console.log("waiting 3 seconds for servers to start...");
  await new Promise(resolve => setTimeout(resolve, 3000));
  if (aggregatorExit) {
    throw new Error(
      `Aggregator exited during startup with code ${aggregatorExit.code}` +
      `${aggregatorExit.signal ? ` (signal ${aggregatorExit.signal})` : ''}. ` +
      `Command was: ${aggregatorCommand}`
    );
  }
}
