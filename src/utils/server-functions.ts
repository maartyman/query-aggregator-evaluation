import {type ChildProcess, exec, spawn} from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {PodContext, ServerInstanceContext} from "../data-generator";
import type {LoggingOptions} from "../main";

export type AuthorizationMode = "no-auth" | "nondelegated" | "delegated";

export interface DistributedServerConfig {
  enabled: boolean;
  aggregator: {
    ssh: string;
    host: string;
    protocol?: string;
    port?: number;
    repoPath: string;
    umaPortBase?: number;
    solidPortBase?: number;
    dataRoot?: string;
  };
  umaCss: {
    ssh: string;
    host: string;
    protocol?: string;
    umaPortBase?: number;
    solidPortBase?: number;
    repoPath: string;
    dataRoot: string;
  };
}

let trackedServers: ServerInstanceContext[] = [];
let trackedAggregatorServers: ServerInstanceContext[] = [];
let distributedConfig: DistributedServerConfig | undefined;
const trackedProcesses = new Map<number, { child: ChildProcess; label: string }>();
const PORT_SHUTDOWN_TIMEOUT_MS = 10_000;
const PROCESS_SHUTDOWN_GRACE_MS = 2_000;
const SERVER_READY_LOG_TIMEOUT_MS = 120_000;
const SSH_CONTROL_DIR = path.join("/tmp", "query-aggregator-evaluation-ssh");
const SSH_CONTROL_PERSIST = getEnvValue("EXPERIMENT_SSH_CONTROL_PERSIST", "10m");
const PERSISTENT_POD_LOG_CONTAINER = "aggregator-control-plane";
const PERSISTENT_POD_LOG_DIRECTORIES = [
  "/tmp/query-aggregator-evaluation/incremunica-logs",
  "/tmp/query-aggregator-evaluation/uma-proxy-logs",
];
const UMA_READY_LOG_PREFIX = "QUERY_AGGREGATOR_EVALUATION_UMA_READY";
const CSS_READY_LOG_PREFIX = "QUERY_AGGREGATOR_EVALUATION_CSS_READY";
const CSS_PAT_READY_LOG_PREFIX = "QUERY_AGGREGATOR_EVALUATION_CSS_PAT_READY";
const AGGREGATOR_READY_LOG_PREFIX = "QUERY_AGGREGATOR_EVALUATION_AGGREGATOR_READY";

interface ManagedProcess {
  child: ChildProcess;
  waitForLog(marker: string, timeoutMs?: number): Promise<void>;
}

export interface ServerLogSink {
  path: string;
  write(label: string, stream: "stdout" | "stderr" | "system", text: string): void;
  close(): Promise<void>;
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

function execCommandStrict(command: string, label: string, logSink?: ServerLogSink): Promise<void> {
  logSink?.write(label, "system", `$ ${command}`);
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (stdout.trim()) {
        logSink?.write(label, "stdout", stdout);
      }
      if (stderr.trim()) {
        logSink?.write(label, "stderr", stderr);
      }
      if (error) {
        reject(new Error(`${label} failed: ${stderr || error.message}`));
        return;
      }
      resolve();
    });
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function getBooleanEnv(name: string, fallback = false): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value);
}

function getEnvValue(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/$/u, "");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function remotePathExpression(value: string): string {
  if (value === "~") {
    return '"${HOME}"';
  }
  if (value.startsWith("~/")) {
    return '"${HOME}"/' + shellQuote(value.slice(2));
  }
  return shellQuote(value);
}

function sshControlPath(target: string): string {
  const safeTarget = target.replace(/[^A-Za-z0-9_.-]/gu, "_");
  return path.join(SSH_CONTROL_DIR, `${safeTarget}.sock`);
}

function sshOptions(target: string): string {
  if (!getBooleanEnv("EXPERIMENT_SSH_MULTIPLEXING", true)) {
    return "";
  }
  fsSync.mkdirSync(SSH_CONTROL_DIR, { recursive: true });
  return [
    "-o ControlMaster=auto",
    `-o ControlPersist=${shellQuote(SSH_CONTROL_PERSIST)}`,
    `-o ControlPath=${shellQuote(sshControlPath(target))}`,
  ].join(" ");
}

function sshOptionArgs(target: string): string[] {
  if (!getBooleanEnv("EXPERIMENT_SSH_MULTIPLEXING", true)) {
    return [];
  }
  fsSync.mkdirSync(SSH_CONTROL_DIR, { recursive: true });
  return [
    "-o", "ControlMaster=auto",
    "-o", `ControlPersist=${SSH_CONTROL_PERSIST}`,
    "-o", `ControlPath=${sshControlPath(target)}`,
  ];
}

function rsyncSshOption(target: string): string {
  const optionsText = sshOptions(target);
  return optionsText ? ` -e ${shellQuote(`ssh ${optionsText}`)}` : "";
}

function remoteScript(script: string, options: { includeToolPath?: boolean } = {}): string {
  const remoteScriptLines = [];
  if (options.includeToolPath) {
    remoteScriptLines.push(`export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:/usr/local/go/bin:$PATH"`);
  }
  remoteScriptLines.push(script);
  return [
    ...remoteScriptLines,
  ].join("\n");
}

function sshCommand(target: string, script: string, options: { includeToolPath?: boolean } = {}): string {
  const scriptContent = remoteScript(script, options);
  const optionsText = sshOptions(target);
  return `ssh ${optionsText ? `${optionsText} ` : ""}${shellQuote(target)} ${shellQuote(`bash -c ${shellQuote(scriptContent)}`)}`;
}

function normalizeBaseUrl(protocol: string, host: string, port: number): string {
  return `${protocol}://${host}:${port}`;
}

function distributedAggregatorPort(): number {
  return distributedConfig?.aggregator.port ?? 5000;
}

function distributedSolidPort(server: ServerInstanceContext): number {
  const base = distributedConfig?.umaCss.solidPortBase ?? 3000;
  return base + server.index;
}

function distributedUmaPort(server: ServerInstanceContext): number {
  const base = distributedConfig?.umaCss.umaPortBase ?? 4000;
  return base + server.index;
}

function distributedAggregatorSolidPort(server: ServerInstanceContext): number {
  const base = distributedConfig?.aggregator.solidPortBase ?? 3000;
  return base + server.index;
}

function distributedAggregatorUmaPort(server: ServerInstanceContext): number {
  const base = distributedConfig?.aggregator.umaPortBase ?? 4000;
  return base + server.index;
}

async function killRemotePort(target: string, port: number, label: string, logSink?: ServerLogSink): Promise<void> {
  const script = [
    `pids=$(lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null || true)`,
    `if [ -n "$pids" ]; then kill $pids 2>/dev/null || true; fi`,
    `sleep 1`,
    `pids=$(lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null || true)`,
    `if [ -n "$pids" ]; then kill -9 $pids 2>/dev/null || true; fi`,
  ].join("\n");
  await execCommandStrict(sshCommand(target, script), label, logSink);
}

async function killRemotePorts(target: string, ports: number[], label: string, logSink?: ServerLogSink): Promise<void> {
  const uniquePorts = [...new Set(ports)].sort((left, right) => left - right);
  if (uniquePorts.length === 0) {
    return;
  }

  const portList = uniquePorts.map(port => String(port)).join(" ");
  const script = [
    `for port in ${portList}; do`,
    `  pids=$(lsof -tiTCP:$port -sTCP:LISTEN 2>/dev/null || true)`,
    `  if [ -n "$pids" ]; then kill $pids 2>/dev/null || true; fi`,
    `done`,
    `sleep 1`,
    `for port in ${portList}; do`,
    `  pids=$(lsof -tiTCP:$port -sTCP:LISTEN 2>/dev/null || true)`,
    `  if [ -n "$pids" ]; then kill -9 $pids 2>/dev/null || true; fi`,
    `done`,
  ].join("\n");
  await execCommandStrict(sshCommand(target, script), label, logSink);
}

async function assertRemoteExecutable(
  target: string,
  executable: string,
  versionArgs: string,
  displayName: string,
  label: string,
  logSink?: ServerLogSink
): Promise<boolean> {
  const script = [
    `if ! command -v ${shellQuote(executable)} >/dev/null 2>&1; then`,
    `  echo ${shellQuote(`${displayName} executable "${executable}" was not found in the SSH session PATH on ${target}.`)} >&2`,
    `  echo "PATH=$PATH" >&2`,
    `  exit 127`,
    `fi`,
    `${shellQuote(executable)} ${versionArgs}`,
  ].join("\n");
  try {
    await execCommandStrict(sshCommand(target, script), label, logSink);
    return false;
  } catch (plainError) {
    try {
      await execCommandStrict(sshCommand(target, script, { includeToolPath: true }), `${label}-WITH-PATH`, logSink);
      return true;
    } catch {
      throw plainError;
    }
  }
}

function backgroundRemoteCommands(commands: string[]): string {
  return [
    `pids=""`,
    `cleanup() { if [ -n "$pids" ]; then kill $pids 2>/dev/null || true; fi; }`,
    `trap cleanup INT TERM EXIT`,
    ...commands.map(command => [
      `(`,
      command,
      `) &`,
      `pids="$pids $!"`,
    ].join("\n")),
    `while :; do`,
    `  for pid in $pids; do`,
    `    if ! kill -0 "$pid" 2>/dev/null; then`,
    `      wait "$pid"`,
    `      status=$?`,
    `      cleanup`,
    `      exit "$status"`,
    `    fi`,
    `  done`,
    `  sleep 1`,
    `done`,
  ].join("\n");
}

export function configureDistributedServers(config?: DistributedServerConfig): void {
  distributedConfig = config?.enabled ? config : undefined;
  if (!distributedConfig) {
    return;
  }

  const aggregatorProtocol = distributedConfig.aggregator.protocol ?? "http";
  const aggregatorPort = distributedConfig.aggregator.port ?? 5000;
  const umaCssProtocol = distributedConfig.umaCss.protocol ?? "http";
  const umaPortBase = distributedConfig.umaCss.umaPortBase ?? 4000;

  process.env.EXPERIMENT_EXTERNAL_SERVERS = "1";
  process.env.SOLID_PROTOCOL = umaCssProtocol;
  process.env.SOLID_HOST = distributedConfig.umaCss.host;
  process.env.SOLID_PORT_BASE = String(distributedConfig.umaCss.solidPortBase ?? 3000);
  process.env.UMA_PROTOCOL = umaCssProtocol;
  process.env.UMA_HOST = distributedConfig.umaCss.host;
  process.env.UMA_PORT_BASE = String(umaPortBase);
  process.env.AGGREGATOR_PROTOCOL = aggregatorProtocol;
  process.env.AGGREGATOR_HOST = distributedConfig.aggregator.host;
  process.env.AGGREGATOR_PORT = String(aggregatorPort);
  process.env.AGGREGATOR_BASE_URL = `${normalizeBaseUrl(aggregatorProtocol, distributedConfig.aggregator.host, aggregatorPort)}/`;

  const dedicatedAggregatorStack = getBooleanEnv("AGGREGATOR_DEDICATED_STACK", true);
  const aggregatorUmaPortBase = distributedConfig.aggregator.umaPortBase ?? 4000;
  const aggregatorSolidPortBase = distributedConfig.aggregator.solidPortBase ?? 3000;

  if (dedicatedAggregatorStack) {
    // The aggregator runs against its own identical CSS/UMA stack, hosted on the aggregator
    // machine. The data generator builds the aggregator pod URLs from these values.
    process.env.AGGREGATOR_SOLID_PROTOCOL = aggregatorProtocol;
    process.env.AGGREGATOR_SOLID_HOST = distributedConfig.aggregator.host;
    process.env.AGGREGATOR_SOLID_PORT_BASE = String(aggregatorSolidPortBase);
    process.env.AGGREGATOR_UMA_PROTOCOL = aggregatorProtocol;
    process.env.AGGREGATOR_UMA_HOST = distributedConfig.aggregator.host;
    process.env.AGGREGATOR_UMA_PORT_BASE = String(aggregatorUmaPortBase);
    process.env.AGGREGATOR_UMA_ISSUER = `${normalizeBaseUrl(aggregatorProtocol, distributedConfig.aggregator.host, aggregatorUmaPortBase)}/uma`;
  } else {
    process.env.AGGREGATOR_UMA_ISSUER = `${normalizeBaseUrl(umaCssProtocol, distributedConfig.umaCss.host, umaPortBase)}/uma`;
  }
}

async function listProcessIdsOnPort(port: number): Promise<number[]> {
  const { stdout, stderr } = await execCommand(`lsof -tiTCP:${port} -sTCP:LISTEN`);
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

async function clearPersistentPodLogs(logSink?: ServerLogSink): Promise<void> {
  const quotedDirectories = PERSISTENT_POD_LOG_DIRECTORIES.map(directory => `"${directory}"`).join(" ");
  const command = `docker exec ${PERSISTENT_POD_LOG_CONTAINER} sh -c 'mkdir -p "$@" && find "$@" -maxdepth 1 -type f -name "*.log" -delete' sh ${quotedDirectories}`;
  logSink?.write("POD-LOGS", "system", `$ ${command}`);
  const { stdout, stderr } = await execCommand(command);
  if (stdout.trim()) {
    logSink?.write("POD-LOGS", "stdout", stdout);
  }
  if (stderr.trim()) {
    logSink?.write("POD-LOGS", "stderr", stderr);
  }
}

export function createServerLogSink(logFilePath: string): ServerLogSink {
  fsSync.mkdirSync(path.dirname(logFilePath), { recursive: true });
  const stream = fsSync.createWriteStream(logFilePath, { flags: "a" });
  let closed = false;

  return {
    path: logFilePath,
    write(label: string, outputStream: "stdout" | "stderr" | "system", text: string): void {
      if (closed) {
        return;
      }
      const timestamp = new Date().toISOString();
      const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
      const lines = trimmed.length > 0 ? trimmed.split(/\r?\n/u) : [""];
      for (const line of lines) {
        stream.write(`[${timestamp}] [${label}] [${outputStream}] ${line}\n`);
      }
    },
    close(): Promise<void> {
      return new Promise(resolve => {
        closed = true;
        stream.end(resolve);
      });
    },
  };
}

function runCommand(command: string, label: string, logSink?: ServerLogSink, debug = false): ManagedProcess {
  logSink?.write(label, "system", `$ ${command}`);
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
    logSink?.write(label, "stdout", text);
    resolveMatchingWaiters();
    if (debug && !logSink) {
      process.stdout.write(`[${label}] ${data as string}`);
    }
  });
  child.stderr?.on('data', (data: unknown) => {
    const text = String(data);
    stderrBuffer = (stderrBuffer + text).slice(-4000);
    logSink?.write(label, "stderr", text);
    if (debug && !logSink) {
      process.stderr.write(`[${label}] ${data as string}`);
    }
  });
  child.on('error', (err) => {
    logSink?.write(label, "system", `process error: ${err instanceof Error ? err.message : String(err)}`);
    if (!logSink) {
      console.error(`[${label}] process error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  if (child.pid) {
    trackedProcesses.set(child.pid, { child, label });
  }
  child.on('exit', (code, signal) => {
    logSink?.write(label, "system", `process exited (code ${code}${signal ? `, signal ${signal}` : ""})`);
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
    if (code && stderrBuffer.trim() && !logSink) {
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

function runRemoteScript(
  target: string,
  script: string,
  label: string,
  logSink?: ServerLogSink,
  debug = false,
  options: { includeToolPath?: boolean } = {}
): ManagedProcess {
  const scriptContent = remoteScript(script, options);
  const args = [
    ...sshOptionArgs(target),
    target,
    "bash",
    "-s",
  ];
  logSink?.write(label, "system", `$ ssh ${args.map(shellQuote).join(" ")} <remote-script:${Buffer.byteLength(scriptContent, "utf8")} bytes>`);
  const child = spawn("ssh", args, {
    stdio: 'pipe',
    detached: true,
    env: {
      ...process.env,
      GOCACHE: process.env.GOCACHE ?? "/tmp/query-aggregator-evaluation-go-build",
    },
  });
  child.stdin?.end(scriptContent);
  const waiters: LogWaiter[] = [];
  let stdoutBuffer = "";
  let stderrBuffer = "";

  const rejectWaiters = (error: Error) => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  };

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
    logSink?.write(label, "stdout", text);
    resolveMatchingWaiters();
    if (debug && !logSink) {
      process.stdout.write(`[${label}] ${data as string}`);
    }
  });
  child.stderr?.on('data', (data: unknown) => {
    const text = String(data);
    stderrBuffer = (stderrBuffer + text).slice(-4000);
    logSink?.write(label, "stderr", text);
    if (debug && !logSink) {
      process.stderr.write(`[${label}] ${data as string}`);
    }
  });
  child.on('error', (err) => {
    const error = new Error(`${label} process error: ${err instanceof Error ? err.message : String(err)}`);
    logSink?.write(label, "system", error.message);
    if (!logSink) {
      console.error(`[${label}] ${error.message}`);
    }
    rejectWaiters(error);
  });
  if (child.pid) {
    trackedProcesses.set(child.pid, { child, label });
  }
  child.on('exit', (code, signal) => {
    logSink?.write(label, "system", `process exited (code ${code}${signal ? `, signal ${signal}` : ""})`);
    if (child.pid) {
      trackedProcesses.delete(child.pid);
    }
    rejectWaiters(new Error(`${label} exited before logging readiness marker.${stderrBuffer ? ` stderr: ${stderrBuffer.trim()}` : ""}`));
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

async function waitForHttpReadiness(
  label: string,
  waits: Array<{ process: ManagedProcess; url: string }>,
  timeoutMs = SERVER_READY_LOG_TIMEOUT_MS
): Promise<void> {
  console.log(`Waiting for ${label} HTTP readiness (${waits.length} process(es))...`);
  const deadline = Date.now() + timeoutMs;

  await Promise.all(waits.map(async wait => {
    while (Date.now() < deadline) {
      if (wait.process.child.exitCode !== null || wait.process.child.signalCode !== null) {
        throw new Error(`${label} exited before responding at ${wait.url}.`);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1_000);
      try {
        const response = await fetch(wait.url, {
          method: "GET",
          signal: controller.signal,
        });
        await response.body?.cancel();
        if (response.status < 500) {
          return;
        }
      } catch {
        // Keep polling until the server starts accepting requests or exits.
      } finally {
        clearTimeout(timeout);
      }

      await sleep(500);
    }

    throw new Error(`Timed out while waiting for ${label} to respond at ${wait.url}.`);
  }));

  console.log(`✓ ${label} HTTP readiness confirmed (${waits.length}/${waits.length} process(es)).`);
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

async function pathIsNonEmptyFile(location: string): Promise<boolean> {
  try {
    const stat = await fs.stat(location);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function precompiledUmaAppIsCurrent(location: string): Promise<boolean> {
  try {
    const content = await fs.readFile(location, "utf8");
    return content.length > 0 && !content.includes(`backup${"FilePath"}`);
  } catch {
    return false;
  }
}

export async function stopServers(servers: ServerInstanceContext[] = trackedServers): Promise<void> {
  const aggregatorServers = trackedAggregatorServers;
  if (distributedConfig) {
    await stopTrackedProcesses();
    await killRemotePort(distributedConfig.aggregator.ssh, distributedAggregatorPort(), "REMOTE-AGGREGATOR-STOP").catch(() => undefined);
    await killRemotePorts(
      distributedConfig.umaCss.ssh,
      servers.flatMap(server => [distributedUmaPort(server), distributedSolidPort(server)]),
      "REMOTE-UMA-CSS-STOP"
    ).catch(() => undefined);
    if (aggregatorServers.length > 0) {
      await killRemotePorts(
        distributedConfig.aggregator.ssh,
        aggregatorServers.flatMap(server => [distributedAggregatorUmaPort(server), distributedAggregatorSolidPort(server)]),
        "REMOTE-AGG-UMA-CSS-STOP"
      ).catch(() => undefined);
    }
    return;
  }

  if (getBooleanEnv("EXPERIMENT_EXTERNAL_SERVERS")) {
    return;
  }

  await stopTrackedProcesses();
  await killProcessOnPort(5000); // aggregator port
  await Promise.all([...servers, ...aggregatorServers].flatMap(server => [
    killProcessOnPort(server.umaPort),
    killProcessOnPort(server.solidPort)
  ]));
}

async function startRemoteUmaCssStack(
  ssh: string,
  host: string,
  protocol: string,
  repoPath: string,
  remoteDataLocation: string,
  servers: ServerInstanceContext[],
  umaPortFn: (server: ServerInstanceContext) => number,
  solidPortFn: (server: ServerInstanceContext) => number,
  authorizationMode: AuthorizationMode,
  fallbackAuthorizedWebId: string,
  resourceRegistrationAuthorizedWebId: string | undefined,
  needsToolPath: boolean,
  labelPrefix: string,
  loggingOptions?: LoggingOptions,
  logSink?: ServerLogSink
): Promise<void> {
  const umaScripts: string[] = [];
  const umaMarkers: string[] = [];
  for (const server of servers) {
    const umaPort = umaPortFn(server);
    const solidPort = solidPortFn(server);
    const umaBaseUrl = normalizeBaseUrl(protocol, host, umaPort) + "/uma";
    const solidBaseUrl = normalizeBaseUrl(protocol, host, solidPort) + "/";
    const umaLocation = `${trimTrailingSlash(repoPath)}/user-managed-access/packages/uma`;
    const umaLogLevel = loggingOptions?.uma ?? "error";
    const umaConfigLocation = authorizationMode === "no-auth"
      ? "./config/no-auth.json"
      : authorizationMode === "nondelegated"
        ? "./config/nondelegated.json"
        : "./config/delegated.json";
    const authorizedWebId = resourceRegistrationAuthorizedWebId?.trim() || fallbackAuthorizedWebId;
    const authorizedWebIdOption = authorizationMode !== "no-auth"
      ? ` --resourceRegistrationAuthorizedWebId ${shellQuote(authorizedWebId)}`
      : "";
    const umaScript = [
      `cd ${remotePathExpression(umaLocation)}`,
      `entry="bin/main.js"`,
      `if [ -f "bin/main-precompiled.js" ] && [ -f "dist/precompiled/app-${authorizationMode}.js" ] && ! grep -q 'backupFilePath' "dist/precompiled/app-${authorizationMode}.js"; then entry="bin/main-precompiled.js --mode ${authorizationMode}"; fi`,
      `node $entry --port ${umaPort} --config-location ${shellQuote(umaConfigLocation)} --base-url ${shellQuote(umaBaseUrl)} --policy-base ${shellQuote(solidBaseUrl)} --log-level ${shellQuote(umaLogLevel)}${authorizedWebIdOption}`,
    ].join("\n");
    umaScripts.push(umaScript);
    umaMarkers.push(`${UMA_READY_LOG_PREFIX} port=${umaPort} baseUrl=${umaBaseUrl}`);
  }

  const umaProcess = runRemoteScript(
    ssh,
    backgroundRemoteCommands(umaScripts),
    `${labelPrefix}REMOTE-UMA`,
    logSink,
    loggingOptions?.uma !== undefined,
    { includeToolPath: needsToolPath }
  );
  const umaWaits = umaMarkers.map(marker => ({ process: umaProcess, marker }));
  await waitForProcessLogs(`${labelPrefix}remote UMA server`, umaWaits);

  const cssWaits: Array<{ process: ManagedProcess; url: string }> = [];
  const cssPatWaits: Array<{ process: ManagedProcess; marker: string }> = [];
  const cssScripts: string[] = [];
  const cssPatMarkers: string[] = [];
  for (const server of servers) {
    const solidPort = solidPortFn(server);
    const solidBaseUrl = normalizeBaseUrl(protocol, host, solidPort) + "/";
    const cssLocation = `${trimTrailingSlash(repoPath)}/user-managed-access/packages/css`;
    const serverDataPath = `${remoteDataLocation}/${server.relativePath}`;
    const cssLogLevel = loggingOptions?.css ?? "error";
    const cssConfigLocation = authorizationMode === "no-auth"
      ? "./config/no-auth.json"
      : "./config/default.json";
    const cssPatConfigLocation = authorizationMode === "no-auth"
      ? ""
      : " ./config/init-pat.json";
    const precompiledApp = authorizationMode === "no-auth" ? "app-no-auth.js" : "app-auth.js";
    const cssLogPrefix = `[${labelPrefix}REMOTE-CSS-${server.index}]`;
    const cssScript = [
      `set -o pipefail`,
      `cd ${remotePathExpression(cssLocation)}`,
      `cmd="yarn run community-solid-server"`,
      `if [ -f "bin/community-solid-server-precompiled.js" ] && [ -s "dist/precompiled/${precompiledApp}" ]; then cmd="node ./bin/community-solid-server-precompiled.js"; fi`,
      `$cmd -m . -c ${cssConfigLocation}${cssPatConfigLocation} --baseUrl ${shellQuote(solidBaseUrl)} -f ${remotePathExpression(serverDataPath)} -p ${solidPort} -l ${shellQuote(cssLogLevel)} 2>&1 | sed -u ${shellQuote(`s/^/${cssLogPrefix} /`)}`,
    ].join("\n");
    cssScripts.push(cssScript);
    if (authorizationMode !== "no-auth") {
      cssPatMarkers.push(`${cssLogPrefix} ${CSS_PAT_READY_LOG_PREFIX} rootFilePath=`);
    }
  }

  const cssProcess = runRemoteScript(
    ssh,
    backgroundRemoteCommands(cssScripts),
    `${labelPrefix}REMOTE-CSS`,
    logSink,
    loggingOptions?.css !== undefined,
    { includeToolPath: needsToolPath }
  );
  for (const server of servers) {
    const solidPort = solidPortFn(server);
    const solidBaseUrl = normalizeBaseUrl(protocol, host, solidPort) + "/";
    cssWaits.push({
      process: cssProcess,
      url: solidBaseUrl,
    });
  }
  for (const marker of cssPatMarkers) {
    cssPatWaits.push({
      process: cssProcess,
      marker,
    });
  }

  const cssPatReady = cssPatWaits.length > 0
    ? waitForProcessLogs(`${labelPrefix}remote CSS PAT bootstrap`, cssPatWaits).catch(error => error)
    : Promise.resolve(undefined);

  await waitForHttpReadiness(`${labelPrefix}remote CSS server`, cssWaits);
  const cssPatError = await cssPatReady;
  if (cssPatError) {
    throw cssPatError;
  }
}

async function startDistributedServers(
  dataLocation: string,
  authorizationMode: AuthorizationMode,
  servers: ServerInstanceContext[],
  queryUser: PodContext,
  loggingOptions?: LoggingOptions,
  resourceRegistrationAuthorizedWebId?: string,
  logSink?: ServerLogSink,
  aggregatorStack?: AggregatorStackConfig
): Promise<void> {
  if (!distributedConfig) {
    throw new Error("Distributed server configuration is not initialized.");
  }

  const remoteExperimentDataLocation = `${trimTrailingSlash(distributedConfig.umaCss.dataRoot)}/${path.basename(dataLocation)}`;
  const aggregatorDataRoot = distributedConfig.aggregator.dataRoot
    ? trimTrailingSlash(distributedConfig.aggregator.dataRoot)
    : undefined;
  const remoteAggregatorDataLocation = aggregatorStack && aggregatorDataRoot
    ? `${aggregatorDataRoot}/${path.basename(aggregatorStack.dataLocation)}`
    : undefined;

  const umaCssNeedsToolPath = await assertRemoteExecutable(
    distributedConfig.umaCss.ssh,
    "node",
    "--version",
    "Node.js",
    "REMOTE-UMA-CSS-NODE-CHECK",
    logSink
  );
  const aggregatorNeedsToolPath = await assertRemoteExecutable(
    distributedConfig.aggregator.ssh,
    "go",
    "version",
    "Go",
    "REMOTE-AGGREGATOR-GO-CHECK",
    logSink
  );
  const aggregatorNodeNeedsToolPath = aggregatorStack
    ? await assertRemoteExecutable(
        distributedConfig.aggregator.ssh,
        "node",
        "--version",
        "Node.js",
        "REMOTE-AGG-UMA-CSS-NODE-CHECK",
        logSink
      )
    : false;

  console.log(`Copying generated experiment data to ${distributedConfig.umaCss.ssh}:${remoteExperimentDataLocation}...`);
  await execCommandStrict(
    sshCommand(distributedConfig.umaCss.ssh, `mkdir -p ${remotePathExpression(remoteExperimentDataLocation)}`),
    "REMOTE-DATA-MKDIR",
    logSink
  );
  await execCommandStrict(
    `rsync -az --delete${rsyncSshOption(distributedConfig.umaCss.ssh)} ${shellQuote(`${trimTrailingSlash(dataLocation)}/`)} ${shellQuote(`${distributedConfig.umaCss.ssh}:${remoteExperimentDataLocation}/`)}`,
    "REMOTE-DATA-RSYNC",
    logSink
  );

  if (aggregatorStack && remoteAggregatorDataLocation) {
    console.log(`Copying mirrored aggregator data to ${distributedConfig.aggregator.ssh}:${remoteAggregatorDataLocation}...`);
    await execCommandStrict(
      sshCommand(distributedConfig.aggregator.ssh, `mkdir -p ${remotePathExpression(remoteAggregatorDataLocation)}`),
      "REMOTE-AGG-DATA-MKDIR",
      logSink
    );
    await execCommandStrict(
      `rsync -az --delete${rsyncSshOption(distributedConfig.aggregator.ssh)} ${shellQuote(`${trimTrailingSlash(aggregatorStack.dataLocation)}/`)} ${shellQuote(`${distributedConfig.aggregator.ssh}:${remoteAggregatorDataLocation}/`)}`,
      "REMOTE-AGG-DATA-RSYNC",
      logSink
    );
  }

  await stopServers(servers);
  await sleep(1000);

  const umaCssProtocol = distributedConfig.umaCss.protocol ?? "http";
  const aggregatorProtocol = distributedConfig.aggregator.protocol ?? "http";
  const aggregatorPort = distributedAggregatorPort();
  const aggregatorBaseUrl = normalizeBaseUrl(aggregatorProtocol, distributedConfig.aggregator.host, aggregatorPort);

  await startRemoteUmaCssStack(
    distributedConfig.umaCss.ssh,
    distributedConfig.umaCss.host,
    umaCssProtocol,
    distributedConfig.umaCss.repoPath,
    remoteExperimentDataLocation,
    servers,
    distributedUmaPort,
    distributedSolidPort,
    authorizationMode,
    queryUser.webId,
    resourceRegistrationAuthorizedWebId,
    umaCssNeedsToolPath,
    "",
    loggingOptions,
    logSink
  );

  if (aggregatorStack && remoteAggregatorDataLocation) {
    console.log("Starting dedicated aggregator CSS/UMA stack on the aggregator machine...");
    await startRemoteUmaCssStack(
      distributedConfig.aggregator.ssh,
      distributedConfig.aggregator.host,
      aggregatorProtocol,
      distributedConfig.aggregator.repoPath,
      remoteAggregatorDataLocation,
      aggregatorStack.servers,
      distributedAggregatorUmaPort,
      distributedAggregatorSolidPort,
      authorizationMode,
      aggregatorStack.queryUser.webId,
      aggregatorStack.resourceRegistrationAuthorizedWebId,
      aggregatorNodeNeedsToolPath,
      "AGG-",
      loggingOptions,
      logSink
    );
  }

  const aggregatorQueryUser = aggregatorStack?.queryUser ?? queryUser;
  const aggregatorLocation = `${trimTrailingSlash(distributedConfig.aggregator.repoPath)}/aggregator`;
  const queryUserWebId = `${aggregatorQueryUser.baseUrl}/profile/card#me`;
  const aggregatorLogLevel = loggingOptions?.aggregator ?? "error";
  const aggregatorFileLogs = logSink ? "1" : "0";
  const aggregatorScript = [
    `cd ${remotePathExpression(aggregatorLocation)}`,
    `EXPERIMENT_SERVER_FILE_LOGS=${shellQuote(aggregatorFileLogs)} PROTOCOL=${shellQuote(aggregatorProtocol)} HOST=${shellQuote(distributedConfig.aggregator.host)} PORT=${aggregatorPort} AS_ISSUER=${shellQuote(aggregatorQueryUser.server.umaBaseUrl)} go run . --webid ${shellQuote(queryUserWebId)} --email ${shellQuote(aggregatorQueryUser.email)} --password password --log-level ${shellQuote(aggregatorLogLevel)}`,
  ].join("\n");
  const aggregatorProcess = runRemoteScript(
    distributedConfig.aggregator.ssh,
    aggregatorScript,
    "REMOTE-AGGREGATOR",
    logSink,
    loggingOptions?.aggregator !== undefined,
    { includeToolPath: aggregatorNeedsToolPath }
  );
  await waitForProcessLogs("remote aggregator", [{
    process: aggregatorProcess,
    marker: `${AGGREGATOR_READY_LOG_PREFIX} port=${aggregatorPort} baseUrl=${aggregatorBaseUrl}`,
  }]);
}

export interface AggregatorStackConfig {
  servers: ServerInstanceContext[];
  dataLocation: string;
  queryUser: PodContext;
  resourceRegistrationAuthorizedWebId?: string;
}

/**
 * Start one UMA + CSS stack (all its servers) locally and wait until every server is ready.
 * Used for both the primary stack and the dedicated aggregator stack.
 */
async function startLocalUmaCssStack(
  umaLocation: string,
  cssLocation: string,
  dataLocation: string,
  authorizationMode: AuthorizationMode,
  servers: ServerInstanceContext[],
  fallbackAuthorizedWebId: string,
  resourceRegistrationAuthorizedWebId: string | undefined,
  labelPrefix: string,
  loggingOptions?: LoggingOptions,
  logSink?: ServerLogSink
): Promise<void> {
  const umaWaits: Array<{ process: ManagedProcess; marker: string }> = [];
  for (const server of servers) {
    const umaLogLevel = loggingOptions?.uma ?? 'error';
    const umaConfigLocation = authorizationMode === "no-auth"
      ? "./config/no-auth.json"
      : authorizationMode === "nondelegated"
        ? "./config/nondelegated.json"
        : "./config/delegated.json";
    const authorizedWebId = resourceRegistrationAuthorizedWebId?.trim() || fallbackAuthorizedWebId;
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
    const process = runCommand(command, `${labelPrefix}UMA-${server.index}`, logSink, loggingOptions?.uma !== undefined);
    umaWaits.push({
      process,
      marker: `${UMA_READY_LOG_PREFIX} port=${server.umaPort} baseUrl=${server.umaBaseUrl}`,
    });
  }

  await waitForProcessLogs(`${labelPrefix}UMA server`, umaWaits);

  const cssConfigLocation = authorizationMode === "no-auth"
    ? "./config/no-auth.json"
    : "./config/default.json";
  const cssPatConfigLocation = authorizationMode === "no-auth"
    ? ""
    : " ./config/init-pat.json";

  const cssWaits: Array<{ process: ManagedProcess; url: string }> = [];
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
    const cssCommand = await pathExists(cssPrecompiledEntry) && await pathIsNonEmptyFile(cssPrecompiledApp)
      ? `node ./bin/community-solid-server-precompiled.js`
      : `yarn run community-solid-server`;
    const command = `cd "${cssLocation}" && ${cssCommand} -m . -c ${cssConfigLocation}${cssPatConfigLocation} --baseUrl ${server.solidBaseUrl} -f "${serverDataPath}" -p ${server.solidPort} -l ${cssLogLevel}`;
    const process = runCommand(command, `${labelPrefix}CSS-${server.index}`, logSink, loggingOptions?.css !== undefined);
    cssWaits.push({
      process,
      url: server.solidBaseUrl,
    });
    if (authorizationMode !== "no-auth") {
      cssPatWaits.push({
        process,
        marker: `${CSS_PAT_READY_LOG_PREFIX} rootFilePath=`,
      });
    }
  }

  const cssPatReady = cssPatWaits.length > 0
    ? waitForProcessLogs(`${labelPrefix}CSS PAT bootstrap`, cssPatWaits).catch(error => error)
    : Promise.resolve(undefined);

  await waitForHttpReadiness(`${labelPrefix}CSS server`, cssWaits);
  const cssPatError = await cssPatReady;
  if (cssPatError) {
    throw cssPatError;
  }
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
  resourceRegistrationAuthorizedWebId?: string,
  logSink?: ServerLogSink,
  aggregatorStack?: AggregatorStackConfig
): Promise<void> {
  trackedServers = servers;
  trackedAggregatorServers = aggregatorStack?.servers ?? [];

  if (distributedConfig) {
    await startDistributedServers(
      dataLocation,
      authorizationMode,
      servers,
      queryUser,
      loggingOptions,
      resourceRegistrationAuthorizedWebId,
      logSink,
      aggregatorStack
    );
    return;
  }

  if (getBooleanEnv("EXPERIMENT_EXTERNAL_SERVERS")) {
    console.log("Using externally managed UMA/CSS/aggregator servers; skipping local server startup.");
    return;
  }

  await stopTrackedProcesses();
  await killProcessOnPort(5000);
  await Promise.all([...servers, ...trackedAggregatorServers].flatMap(server => [
    killProcessOnPort(server.umaPort),
    killProcessOnPort(server.solidPort)
  ]));
  if (logSink) {
    await clearPersistentPodLogs(logSink);
  }
  await sleep(1000);

  await startLocalUmaCssStack(
    umaLocation,
    cssLocation,
    dataLocation,
    authorizationMode,
    servers,
    queryUser.webId,
    resourceRegistrationAuthorizedWebId,
    "",
    loggingOptions,
    logSink
  );

  if (aggregatorStack) {
    console.log("Starting dedicated aggregator CSS/UMA stack...");
    await startLocalUmaCssStack(
      umaLocation,
      cssLocation,
      aggregatorStack.dataLocation,
      authorizationMode,
      aggregatorStack.servers,
      aggregatorStack.queryUser.webId,
      aggregatorStack.resourceRegistrationAuthorizedWebId,
      "AGG-",
      loggingOptions,
      logSink
    );
  }

  const aggregatorQueryUser = aggregatorStack?.queryUser ?? queryUser;
  const queryUserWebId = `${aggregatorQueryUser.baseUrl}/profile/card#me`;
  console.log("Starting aggregator...");
  const aggregatorLogLevel = loggingOptions?.aggregator ?? 'error';
  const aggregatorFileLogs = logSink ? "1" : "0";
  const aggregatorProtocol = getEnvValue("AGGREGATOR_PROTOCOL", "http");
  const aggregatorHost = getEnvValue("AGGREGATOR_HOST", "localhost");
  const aggregatorPort = getEnvValue("AGGREGATOR_PORT", "5000");
  const aggregatorBaseUrl = trimTrailingSlash(process.env.AGGREGATOR_BASE_URL ?? `${aggregatorProtocol}://${aggregatorHost}:${aggregatorPort}`);
  const aggregatorCommand = `cd "${aggregatorLocation}" && EXPERIMENT_SERVER_FILE_LOGS=${aggregatorFileLogs} PROTOCOL=${aggregatorProtocol} HOST=${aggregatorHost} PORT=${aggregatorPort} AS_ISSUER=${aggregatorQueryUser.server.umaBaseUrl} go run . --webid ${queryUserWebId} --email ${aggregatorQueryUser.email} --password password --log-level ${aggregatorLogLevel}`;
  const aggregatorProcess = runCommand(aggregatorCommand, "AGGREGATOR", logSink, loggingOptions?.aggregator !== undefined);
  await waitForProcessLogs("aggregator", [{
    process: aggregatorProcess,
    marker: `${AGGREGATOR_READY_LOG_PREFIX} port=${aggregatorPort} baseUrl=${aggregatorBaseUrl}`,
  }]);
}
