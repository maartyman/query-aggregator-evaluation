import {exec, spawn} from "node:child_process";
import path from "node:path";
import {PodContext, ServerInstanceContext} from "../data-generator";
import type {LoggingOptions} from "../main";

let trackedServers: ServerInstanceContext[] = [];

function killProcessOnPort(port: number): void {
  exec(`lsof -ti:${port}`, (error, stdout, stderr) => {
    if (error || stderr) {
      return;
    }
    const pids = stdout.trim().split('\n').filter(pid => pid);
    if (pids.length === 0) {
      return;
    }
    console.log(`Killing processes on port ${port}: ${pids.join(', ')}`);
    exec(`kill ${pids.join(' ')}`, (killError, _killStdout, killStderr) => {
      if (killError) {
        console.error(`Error killing processes on port ${port}: ${killError.message}`);
      } else if (killStderr) {
        console.error(`Stderr while killing processes on port ${port}: ${killStderr}`);
      }
    });
  });
}

function runCommand(command: string, label: string, debug: boolean): void {
  const child = spawn(command, {
    shell: true,
    stdio: debug ? 'pipe' : 'ignore',
    env: process.env,
  });
  if (debug) {
    child.stdout?.on('data', (data: unknown) => {
      process.stdout.write(`[${label}] ${data as string}`);
    });
    child.stderr?.on('data', (data: unknown) => {
      process.stderr.write(`[${label}] ${data as string}`);
    });
  }
  child.on('error', (err) => {
    console.error(`[${label}] process error: ${err instanceof Error ? err.message : String(err)}`);
  });
  child.on('exit', (code, signal) => {
    console.log(`[${label}] exited with code ${code}${signal ? ` (signal ${signal})` : ''}`);
  });
}

export function stopServers(servers: ServerInstanceContext[] = trackedServers): void {
  console.log("Stopping existing servers...");
  killProcessOnPort(5000); // aggregator port
  for (const server of servers) {
    killProcessOnPort(server.umaPort);
    killProcessOnPort(server.solidPort);
  }
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
  killProcessOnPort(5000);
  for (const server of servers) {
    killProcessOnPort(server.umaPort);
    killProcessOnPort(server.solidPort);
  }
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
  runCommand(`cd "${aggregatorLocation}" && go run . --webid ${queryUserWebId} --email ${queryUser.email} --password password --log-level ${aggregatorLogLevel}`, "AGGREGATOR", loggingOptions?.aggregator !== undefined);

  console.log("waiting 3 seconds for servers to start...");
  await new Promise(resolve => setTimeout(resolve, 3000));
}
