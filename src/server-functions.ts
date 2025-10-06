import {ChildProcess, exec} from "node:child_process";
import {promisify} from "node:util";

const execAsync = promisify(exec);

async function killProcessOnPort(port: number): Promise<void> {
  try {
    // Find processes using the port
    const { stdout } = await execAsync(`lsof -ti:${port}`);
    const pids = stdout.trim().split('\n').filter(pid => pid);

    if (pids.length > 0) {
      console.log(`Killing processes on port ${port}: ${pids.join(', ')}`);
      // Kill the processes
      await execAsync(`kill -9 ${pids.join(' ')}`);
      console.log(`Successfully killed processes on port ${port}`);
    }
  } catch (error) {
    // No processes found on port, which is fine
    console.log(`No processes found on port ${port}`);
  }
}

export async function stopServers(processes: ChildProcess[]) {
  console.log("Stopping existing servers...");
  await killProcessOnPort(4000); // UMA port
  await killProcessOnPort(3000); // CSS port

  console.log("Server shutdown complete");
}

export async function startServers(umaLocation: string, cssLocation: string, dataLocation: string): Promise<ChildProcess[]> {
  // Kill any existing processes on the ports we need
  console.log("Cleaning up existing processes...");
  await killProcessOnPort(4000); // UMA port
  await killProcessOnPort(3000); // CSS port

  let processes: ChildProcess[] = [];
  console.log("Starting uma...");
  // start uma
  processes.push(exec(`node ${umaLocation}/bin/main.js`));
  console.log("waiting 2 seconds for uma to start...");
  await new Promise(resolve => setTimeout(resolve, 2000));
  console.log("Starting css...");
  processes.push(exec(`cd ${cssLocation} && yarn run community-solid-server -m . -c ./config/default.json -a http://localhost:4000/ -f ${dataLocation} -l warn`));
  console.log("waiting 15 seconds for css to start...");
  await new Promise(resolve => setTimeout(resolve, 15000));

  return processes;
}

/*
export async function loadData(experimentData: string) {
  console.log("Loading data into css...");

  async function loadFileIntoPod(filePath: string, podName: string, relativePath: string) {
    const fileContent = fs.readFileSync(filePath);
    const url = `http://localhost:3000/${podName}/${relativePath}`.replace("$.ttl", "");

    try {
      const response = await fetch(url, {
        method: 'PUT',
        body: fileContent,
        headers: {
          'Content-Type': 'text/turtle'
        }
      });

      if (response.ok) {
        console.log(`✓ Loaded ${relativePath} into ${url}`);
      } else {
        console.error(`✗ Failed to load ${relativePath} into ${url}: ${response.status} ${response.statusText}\n${await response.text()}`);
        return false;
      }
    } catch (error) {
      console.error(`✗ Error loading ${relativePath} into ${url}:`, error);
      return false;
    }
    return true;
  }

  async function loadPodDataRecursively(podPath: string, podName: string, currentPath: string = '') {
    const items = fs.readdirSync(podPath);

    for (const item of items) {
      const fullItemPath = path.join(podPath, item);
      const relativePath = currentPath ? `${currentPath}/${item}` : item;

      if (fs.statSync(fullItemPath).isDirectory()) {
        // Recursively process subdirectory
        if (!await loadPodDataRecursively(fullItemPath, podName, relativePath)) {
          console.error(`Stopping further uploads to pod ${podName} due to error.`);
          return false;
        }
      } else {
        // Load file into pod
        if (!await loadFileIntoPod(fullItemPath, podName, relativePath)) {
          console.error(`Stopping further uploads to pod ${podName} due to error.`);
          return false;
        }
      }
    }
    return true;
  }

  // Load data for each pod
  const pods = fs.readdirSync(experimentData);
  for (const pod of pods) {
    const podPath = path.join(experimentData, pod);
    if (fs.statSync(podPath).isDirectory()) {
      console.log(`Loading data for pod: ${pod}`);
      if (!await loadPodDataRecursively(podPath, pod)) {
        console.error(`Error occurred while loading data for pod ${pod}. Stopping further processing.`);
        break;
      }
    }
  }

  console.log("Finished loading data into all pods.");
}
*/
