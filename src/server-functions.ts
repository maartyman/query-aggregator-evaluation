import {exec} from "node:child_process";

function killProcessOnPort(port: number): void {
    // Find processes using the port
    exec(`lsof -ti:${port}`, (error, stdout, stderr) => {
      if (error) {
        return;
      }
      if (stderr) {
        return;
      }
      const pids = stdout.trim().split('\n').filter(pid => pid);
      if (pids.length > 0) {
        console.log(`Killing processes on port ${port}: ${pids.join(', ')}`);
        // Kill the processes
        exec(`kill ${pids.join(' ')}`, (killError, killStdout, killStderr) => {
          if (killError) {
            console.error(`Error killing processes on port ${port}: ${killError.message}`);
            return;
          }
          if (killStderr) {
            console.error(`Stderr while killing processes on port ${port}: ${killStderr}`);
            return;
          }
        });
      }
    });
}

export function stopServers() {
  console.log("Stopping existing servers...");
  killProcessOnPort(5000); // aggregator port
  killProcessOnPort(4000); // UMA port
  killProcessOnPort(3000); // CSS port

  console.log("Server shutdown complete");
}

export async function startServers(
  umaLocation: string,
  cssLocation: string,
  aggregatorLocation: string,
  dataLocation: string,
  queryUser: string
): Promise<void> {
  // Kill any existing processes on the ports we need
  console.log("Cleaning up existing processes...");
  killProcessOnPort(5000); // aggregator port
  killProcessOnPort(4000); // UMA port
  killProcessOnPort(3000); // CSS port
  await new Promise(resolve => setTimeout(resolve, 1000));

  console.log("Starting uma...");
  exec(`node ${umaLocation}/bin/main.js`);
  console.log("waiting 2 seconds before starting css...");
  await new Promise(resolve => setTimeout(resolve, 2000));
  console.log("Starting css...");
  exec(`cd ${cssLocation} && yarn run community-solid-server -m . -c ./config/default.json -a http://localhost:4000/ -f ${dataLocation} -l error`);
  console.log("waiting 15 seconds before starting aggregator...");
  await new Promise(resolve => setTimeout(resolve, 15000));
  console.log("Starting aggregator...");
  exec(`cd ${aggregatorLocation} && go run . --webid http://localhost:3000/${queryUser}/profile/card#me --email ${queryUser}@example.org --password password --log-level error`);
  console.log("waiting 2 seconds for servers to start...");
  await new Promise(resolve => setTimeout(resolve, 1000));
}
