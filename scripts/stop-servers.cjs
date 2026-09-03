#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SSH_CONTROL_DIR = path.join("/tmp", "query-aggregator-evaluation-ssh");
const SSH_CONTROL_PERSIST = process.env.EXPERIMENT_SSH_CONTROL_PERSIST || "10m";

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  return process.argv[index + 1];
}

function readBooleanArg(name) {
  return process.argv.includes(name);
}

function readInteger(value, name) {
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got: ${value}`);
  }
  return parsed;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function getBooleanEnv(name, fallback = false) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value);
}

function sshControlPath(target) {
  const safeTarget = target.replace(/[^A-Za-z0-9_.-]/g, "_");
  return path.join(SSH_CONTROL_DIR, `${safeTarget}.sock`);
}

function sshArgs(target) {
  if (!getBooleanEnv("EXPERIMENT_SSH_MULTIPLEXING", true)) {
    return [target, "bash", "-s"];
  }
  fs.mkdirSync(SSH_CONTROL_DIR, { recursive: true });
  return [
    "-o", "ControlMaster=auto",
    "-o", `ControlPersist=${SSH_CONTROL_PERSIST}`,
    "-o", `ControlPath=${sshControlPath(target)}`,
    target,
    "bash",
    "-s",
  ];
}

function closeSshMaster(target) {
  if (!getBooleanEnv("EXPERIMENT_SSH_MULTIPLEXING", true)) {
    return;
  }
  const controlPath = sshControlPath(target);
  if (!fs.existsSync(controlPath)) {
    return;
  }
  spawnSync("ssh", [
    "-o", `ControlPath=${controlPath}`,
    "-O", "exit",
    target,
  ], { stdio: "ignore" });
}

function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function scanMaxServerIndex(root) {
  if (!fs.existsSync(root)) {
    return -1;
  }

  let max = -1;
  const stack = [{ location: root, depth: 0 }];
  while (stack.length > 0) {
    const { location, depth } = stack.pop();
    if (depth > 4) {
      continue;
    }
    let entries;
    try {
      entries = fs.readdirSync(location, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const match = /^server-(\d+)$/u.exec(entry.name);
      if (match) {
        max = Math.max(max, Number(match[1]));
        continue;
      }
      stack.push({ location: path.join(location, entry.name), depth: depth + 1 });
    }
  }
  return max;
}

function inferServerCount(config, configPath) {
  const explicit = readInteger(
    readArg("--count") || process.env.EXPERIMENT_STOP_SERVER_COUNT || process.env.STOP_SERVER_COUNT,
    "--count"
  );
  if (explicit !== undefined) {
    return explicit;
  }

  const dataRoot = process.env.EXPERIMENT_DATA_ROOT ||
    config.experimentDataRoot ||
    config.distributed?.umaCss?.dataRoot ||
    "./experiment-data";
  const localDataRoot = dataRoot.startsWith("~/")
    ? path.join(process.env.HOME || "", dataRoot.slice(2))
    : path.resolve(path.dirname(configPath), "..", dataRoot);
  const maxServerIndex = scanMaxServerIndex(localDataRoot);
  if (maxServerIndex >= 0) {
    return maxServerIndex + 1;
  }

  return readInteger(process.env.EXPERIMENT_STOP_DEFAULT_SERVER_COUNT, "EXPERIMENT_STOP_DEFAULT_SERVER_COUNT") ?? 256;
}

function range(base, count) {
  return Array.from({ length: count }, (_, index) => base + index);
}

function buildStopScript(ports) {
  const uniquePorts = [...new Set(ports)].sort((left, right) => left - right);
  return [
    `set +e`,
    `ports=${shellQuote(uniquePorts.join(" "))}`,
    `find_pids() {`,
    `  if command -v lsof >/dev/null 2>&1; then`,
    `    lsof -tiTCP:$1 -sTCP:LISTEN 2>/dev/null || true`,
    `  elif command -v fuser >/dev/null 2>&1; then`,
    `    fuser -n tcp "$1" 2>/dev/null || true`,
    `  else`,
    `    echo "Neither lsof nor fuser is available; cannot inspect TCP port $1." >&2`,
    `    return 1`,
    `  fi`,
    `}`,
    `for port in $ports; do`,
    `  pids=$(find_pids "$port")`,
    `  if [ -n "$pids" ]; then`,
    `    echo "Stopping listener(s) on port $port: $pids"`,
    `    kill $pids 2>/dev/null || true`,
    `  fi`,
    `done`,
    `sleep 1`,
    `for port in $ports; do`,
    `  pids=$(find_pids "$port")`,
    `  if [ -n "$pids" ]; then`,
    `    echo "Force stopping listener(s) on port $port: $pids"`,
    `    kill -9 $pids 2>/dev/null || true`,
    `  fi`,
    `done`,
  ].join("\n");
}

function runStopScript(target, ports, dryRun) {
  const script = buildStopScript(ports);
  if (dryRun) {
    console.log(`Would stop ${ports.length} port(s) on ${target || "local"}: ${[...new Set(ports)].sort((a, b) => a - b).join(", ")}`);
    return;
  }

  const command = target ? "ssh" : "bash";
  const args = target ? sshArgs(target) : ["-s"];
  console.log(`Stopping ${ports.length} configured port(s) on ${target || "local"}...`);
  const result = spawnSync(command, args, {
    input: script,
    stdio: ["pipe", "inherit", "inherit"],
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
  if (target) {
    closeSshMaster(target);
  }
}

function main() {
  const configPath = path.resolve(readArg("--config") || "./configs/complete-config.json");
  const config = loadConfig(configPath);
  const dryRun = readBooleanArg("--dry-run");
  const count = inferServerCount(config, configPath);
  const distributed = config.distributed?.enabled ? config.distributed : undefined;

  const aggregatorPort = readInteger(process.env.AGGREGATOR_PORT, "AGGREGATOR_PORT") ??
    distributed?.aggregator?.port ??
    5000;
  const solidPortBase = readInteger(process.env.SOLID_PORT_BASE, "SOLID_PORT_BASE") ??
    distributed?.umaCss?.solidPortBase ??
    3000;
  const umaPortBase = readInteger(process.env.UMA_PORT_BASE, "UMA_PORT_BASE") ??
    distributed?.umaCss?.umaPortBase ??
    4000;

  const serverPorts = [
    ...range(solidPortBase, count),
    ...range(umaPortBase, count),
  ];

  if (distributed) {
    const portsByTarget = new Map();
    portsByTarget.set(distributed.aggregator.ssh, [
      ...(portsByTarget.get(distributed.aggregator.ssh) || []),
      aggregatorPort,
    ]);
    portsByTarget.set(distributed.umaCss.ssh, [
      ...(portsByTarget.get(distributed.umaCss.ssh) || []),
      ...serverPorts,
    ]);
    for (const [target, ports] of portsByTarget) {
      runStopScript(target, ports, dryRun);
    }
  } else {
    runStopScript(undefined, [aggregatorPort, ...serverPorts], dryRun);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
