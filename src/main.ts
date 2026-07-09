import {type AuthorizationMode, startServers, stopServers} from "./utils/server-functions";
import * as path from 'path';
import * as fs from 'fs';
import type {Experiment} from "./experiment";
import type {ExperimentSetup} from "./data-generator";
import {OverviewPageExperiment} from "./watch-party/overview-page-experiment";
import {WatchPageExperiment} from "./watch-party/watch-page-experiment";
import {Auth} from "./utils/auth";
import {Logger, type LogLevel} from './utils/logger';
import {ActivityPageExperiment} from "./elevate/activity-page-experiment";
import {getAggregatorIdStore} from "./utils/aggregator-id-store";
import {ActivitiesPageExperiment} from "./elevate/activities-page-experiment";
import {ExperimentResult} from "./utils/result-builder";

process.stdin.resume();

function exitHandler() {
  //stopServers();
  process.exit();
}

// do something when app is closing
process.on('exit', exitHandler);

// catches ctrl+c event
process.on('SIGINT', exitHandler);

// catches "kill pid" (for example: nodemon restart)
process.on('SIGUSR1', exitHandler);
process.on('SIGUSR2', exitHandler);

// catches uncaught exceptions
process.on('uncaughtException', exitHandler);

export interface LoggingOptions {
  experiment?: LogLevel;
  aggregator?: string;
  uma?: string;
  css?: string;
}

export interface ExperimentConfig {
  type: string;
  authorizationModes?: AuthorizationMode[];
  delegatedAuth?: boolean;
  iterations: Array<{
    iterationName: string;
    args: any[][];
  }>;
  podsPerServer?: number;
}

export interface Config {
  podsPerServer: number;
  useExistingData?: boolean;
  experimentDataRoot?: string;
  resourceRegistrationAuthorizedWebId?: string;
  experiments: Record<string, ExperimentConfig>;
}

function getNonNegativeIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number, got: ${value}`);
  }
  return Math.floor(parsed);
}

const WARMUP_RUNS = getNonNegativeIntegerEnv("WARMUP_RUNS", 1);
const RECORDED_RUNS = getNonNegativeIntegerEnv("RECORDED_RUNS", 30);
const EXPERIMENT_ATTEMPTS = Math.max(1, getNonNegativeIntegerEnv("EXPERIMENT_ATTEMPTS", 5));

function formatTimestamp(date: Date): string {
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const millis = Math.round(milliseconds % 1000);

  const parts = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || hours > 0) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds}.${String(millis).padStart(3, "0")}s`);
  return parts.join(" ");
}

function getLoggingOptionsFromEnv(): LoggingOptions | undefined {
  const loggingOptions: LoggingOptions = {};
  if (process.env.EXPERIMENT_LOG_LEVEL) {
    loggingOptions.experiment = process.env.EXPERIMENT_LOG_LEVEL as LogLevel;
  }
  if (process.env.AGGREGATOR_LOG_LEVEL) {
    loggingOptions.aggregator = process.env.AGGREGATOR_LOG_LEVEL;
  }
  if (process.env.UMA_LOG_LEVEL) {
    loggingOptions.uma = process.env.UMA_LOG_LEVEL;
  }
  if (process.env.CSS_LOG_LEVEL) {
    loggingOptions.css = process.env.CSS_LOG_LEVEL;
  }

  return Object.keys(loggingOptions).length > 0 ? loggingOptions : undefined;
}

function getIterationMetadata(
  experimentId: string,
  experimentConfig: ExperimentConfig
): { iterationName: string; iterationArgs: string } | null {
  const candidates: Array<{ prefix: string; iterationName: string; iterationArgs: string }> = [];

  for (const iterationConfig of experimentConfig.iterations) {
    for (const arg of iterationConfig.args) {
      const iterationArgs = arg.map(value => String(value)).join("_");
      const normalizedIterationArgs = iterationArgs.toLowerCase();
      const argEncodings = new Set([iterationArgs, normalizedIterationArgs]);

      for (const encodedArgs of argEncodings) {
        candidates.push({
          prefix: `${iterationConfig.iterationName}-${encodedArgs}_`,
          iterationName: iterationConfig.iterationName,
          iterationArgs
        });
      }
    }
  }

  candidates.sort((a, b) => b.prefix.length - a.prefix.length);

  for (const candidate of candidates) {
    if (experimentId.startsWith(candidate.prefix)) {
      return {
        iterationName: candidate.iterationName,
        iterationArgs: candidate.iterationArgs
      };
    }
  }

  return null;
}

async function runExperiment(
  experimentName: string,
  experimentConfig: ExperimentConfig,
  useExistingData: boolean,
  authorizationMode: AuthorizationMode,
  loggingOptions?: LoggingOptions,
  resourceRegistrationAuthorizedWebId?: string,
  experimentDataRoot: string = "./experiment-data"
): Promise<ExperimentResult[]> {
  if (loggingOptions?.experiment) {
    Logger.setLevel(loggingOptions.experiment);
  }

  const experimentLocation = path.resolve(experimentDataRoot, experimentName);
  let experiment: Experiment | null = null;
  let setup: ExperimentSetup | null = null;

  const configWithAuthorizationMode = {
    ...experimentConfig,
    authorizationMode,
    delegatedAuth: authorizationMode === "delegated",
    podsPerServer: experimentConfig.podsPerServer
  };

  switch (experimentConfig.type) {
    case "watchparty-overview-page":
      experiment = new OverviewPageExperiment(experimentLocation, configWithAuthorizationMode);
      break;
    case "watchparty-watch-page":
      experiment = new WatchPageExperiment(experimentLocation, configWithAuthorizationMode);
      break;
    case "elevate-activity-page":
      experiment = new ActivityPageExperiment(experimentLocation, configWithAuthorizationMode);
      break;
    case "elevate-activities-page":
      experiment = new ActivitiesPageExperiment(experimentLocation, configWithAuthorizationMode);
      break;
    case "elevate-fitness-trend-page":
      experiment = new ActivitiesPageExperiment(experimentLocation, configWithAuthorizationMode);
      break;
    case "elevate-yearly-progression-page":
      experiment = new ActivitiesPageExperiment(experimentLocation, configWithAuthorizationMode);
      break;
    default:
      throw new Error(`Unknown experiment type: ${experimentConfig.type}`);
  }
  if (!experiment) {
    throw new Error(`Could not create experiment of type: ${experimentConfig.type}`);
  }

  await Auth.resetCache();

  if (!useExistingData || !fs.existsSync(experimentLocation)) {
    setup = experiment.generate();
  } else {
    console.log(`Using existing data for experiment: ${experimentName}`);
    setup = experiment.generate();
  }

  try {
    await startServers(
      path.resolve("./user-managed-access/packages/uma"),
      path.resolve("./user-managed-access/packages/css"),
      path.resolve("./aggregator"),
      experimentLocation,
      authorizationMode,
      setup.servers,
      setup.queryUser,
      loggingOptions,
      resourceRegistrationAuthorizedWebId?.trim() || setup.queryUsers.map(user => user.webId).join(",")
    );

    getAggregatorIdStore().clear();

    if (WARMUP_RUNS > 0) {
      console.log(`Running ${WARMUP_RUNS} warmup run(s) for local conditions...`);
      await experiment.runLocal(WARMUP_RUNS);
      console.log(`Running ${WARMUP_RUNS} warmup run(s) for aggregator conditions...`);
      await experiment.runAggregator(WARMUP_RUNS);
      if (experiment.runAggregatorDiscovered) {
        console.log(`Running ${WARMUP_RUNS} warmup run(s) for discovered aggregator conditions...`);
        await experiment.runAggregatorDiscovered(WARMUP_RUNS);
      }
    } else {
      console.log("Skipping warmup runs.");
    }

    console.log(`Running ${RECORDED_RUNS} recorded run(s) for local conditions...`);
    const resultsLocal = await experiment.runLocal(RECORDED_RUNS);
    console.log(`Running ${RECORDED_RUNS} recorded run(s) for aggregator conditions...`);
    const resultsAggregator = await experiment.runAggregator(RECORDED_RUNS);
    let resultsAggregatorDiscovered: ExperimentResult[] = [];
    if (experiment.runAggregatorDiscovered) {
      console.log(`Running ${RECORDED_RUNS} recorded run(s) for discovered aggregator conditions...`);
      resultsAggregatorDiscovered = await experiment.runAggregatorDiscovered(RECORDED_RUNS);
    }

    return [...resultsLocal, ...resultsAggregator, ...resultsAggregatorDiscovered];
  } finally {
    await stopServers(setup.servers);
  }
}

async function runExperimentWithRetries(
  fullExperimentName: string,
  experimentName: string,
  experimentConfig: ExperimentConfig,
  useExistingData: boolean,
  authorizationMode: AuthorizationMode,
  loggingOptions?: LoggingOptions,
  resourceRegistrationAuthorizedWebId?: string,
  experimentDataRoot?: string
): Promise<ExperimentResult[]> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= EXPERIMENT_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      console.log(`Retrying ${fullExperimentName}, attempt ${attempt}/${EXPERIMENT_ATTEMPTS}...`);
    }

    try {
      return await runExperiment(
        experimentName,
        experimentConfig,
        useExistingData,
        authorizationMode,
        loggingOptions,
        resourceRegistrationAuthorizedWebId,
        experimentDataRoot
      );
    } catch (error) {
      lastError = error;
      if (attempt >= EXPERIMENT_ATTEMPTS) {
        break;
      }

      const message = error instanceof Error ? error.message : String(error);
      console.error(`✗ Attempt ${attempt}/${EXPERIMENT_ATTEMPTS} failed for ${fullExperimentName}: ${message}`);
      await stopServers();
      console.log(`Restarting servers and retrying ${fullExperimentName}...\n`);
    }
  }

  throw lastError;
}

async function main() {
  const runStartedAt = new Date();
  const runStartedHrTime = process.hrtime.bigint();
  const configArgIndex = process.argv.indexOf("--config");
  const configPath = path.resolve(
    configArgIndex >= 0 && process.argv[configArgIndex + 1]
      ? process.argv[configArgIndex + 1]
      : './configs/complete-config.json'
  );

  if (!fs.existsSync(configPath)) {
    console.error(`Config file not found: ${configPath}`);
    process.exit(1);
  }

  const configContent = fs.readFileSync(configPath, 'utf-8');
  const config: Config = JSON.parse(configContent);

  const resultsDir = path.resolve('./results');
  fs.mkdirSync(resultsDir, { recursive: true });

  const failedExperiments: Array<{name: string, error: any}> = [];
  const successfulExperiments: string[] = [];
  const loggingOptions = getLoggingOptionsFromEnv();
  const resourceRegistrationAuthorizedWebId =
    process.env.UMA_RESOURCE_REGISTRATION_AUTHORIZED_WEBID?.trim() ||
    config.resourceRegistrationAuthorizedWebId?.trim();
  const experimentDataRoot = process.env.EXPERIMENT_DATA_ROOT?.trim() ||
    config.experimentDataRoot?.trim() ||
    "./experiment-data";

  for (const [experimentName, experimentConfig] of Object.entries(config.experiments)) {
    console.log(`\n========================================`);
    console.log(`Starting experiment: ${experimentName}`);
    console.log(`========================================\n`);

    const podsPerServer = experimentConfig.podsPerServer ?? config.podsPerServer;
    const configWithPods = { ...experimentConfig, podsPerServer };

    const authorizationModes: AuthorizationMode[] = experimentConfig.authorizationModes ??
      (experimentConfig.delegatedAuth === undefined
        ? ["no-auth", "nondelegated", "delegated"]
        : [experimentConfig.delegatedAuth ? "delegated" : "nondelegated"]);

    const includeAuthorizationModeSuffix = authorizationModes.length > 1;

    for (const authorizationMode of authorizationModes) {
      const suffix = includeAuthorizationModeSuffix ? `-${authorizationMode}` : '';

      const fullExperimentName = `${experimentName}${suffix}`;

      console.log(`Running ${fullExperimentName} (authorizationMode: ${authorizationMode})...`);

      try {
        const results = await runExperimentWithRetries(
          fullExperimentName,
          experimentName,
          configWithPods,
          config.useExistingData ?? false,
          authorizationMode,
          loggingOptions,
          resourceRegistrationAuthorizedWebId,
          experimentDataRoot
        );

        const resultRunCounts = new Map<string, number>();

        for (const result of results) {
          try {
            if (!result.parameters) {
              result.parameters = {};
            }

            result.parameters.experimentName = experimentName;
            result.parameters.experimentType = experimentConfig.type;
            result.parameters.authorizationMode = authorizationMode;
            result.parameters.delegatedAuth = authorizationMode === "delegated";
            result.parameters.podsPerServer = podsPerServer;
            result.parameters.useExistingData = config.useExistingData ?? false;
            result.parameters.warmupRuns = WARMUP_RUNS;
            result.parameters.recordedRuns = RECORDED_RUNS;

            const idParts = result.experimentId.split('_');
            const iterationMetadata = getIterationMetadata(result.experimentId, experimentConfig);

            if (iterationMetadata) {
              result.parameters.iterationName = iterationMetadata.iterationName;
              result.parameters.iterationArgs = iterationMetadata.iterationArgs;
            }

            if (idParts.includes('aggregator')) {
              result.parameters.useAggregator = true;
              const aggregatorIndex = idParts.indexOf('aggregator');
              const discovered = idParts[aggregatorIndex + 1] === 'discovered';
              result.parameters.executionType = discovered ? 'aggregator-discovered' : 'aggregator';
              const cacheIndex = aggregatorIndex + (discovered ? 2 : 1);
              if (cacheIndex < idParts.length) {
                result.parameters.cacheStrategy = idParts[cacheIndex];
              }
            } else {
              result.parameters.useAggregator = false;
              result.parameters.executionType = idParts[idParts.length - 1] === 'indexed-cache' ? 'local-indexed-cache' : 'local';
              if (idParts.length > 0) {
                result.parameters.cacheStrategy = idParts[idParts.length - 1];
              }
            }

            const runIndex = (resultRunCounts.get(result.experimentId) ?? 0) + 1;
            resultRunCounts.set(result.experimentId, runIndex);
            result.parameters.measurementRun = runIndex;

            const runLabel = String(runIndex).padStart(String(RECORDED_RUNS).length, '0');
            const resultFileName = `${result.experimentId}_run-${runLabel}${suffix}.json`;
            const resultPath = path.join(resultsDir, resultFileName);
            result.save(resultPath);
          } catch (saveError) {
            console.error(`✗ Failed to save result for ${result.experimentId}:`, saveError);
          }
        }

        successfulExperiments.push(fullExperimentName);
        console.log(`✓ Completed ${fullExperimentName}`);
      } catch (error) {
        failedExperiments.push({name: fullExperimentName, error});
        console.error(`✗ Failed ${fullExperimentName}:`, error);
        console.log(`Continuing with next experiment...\n`);
      }
    }
  }

  const runFinishedAt = new Date();
  const runDurationMs = Number(process.hrtime.bigint() - runStartedHrTime) / 1_000_000;

  console.log(`\n========================================`);
  console.log(`EXPERIMENT SUMMARY`);
  console.log(`========================================`);
  console.log(`Started: ${formatTimestamp(runStartedAt)}`);
  console.log(`Finished: ${formatTimestamp(runFinishedAt)}`);
  console.log(`Duration: ${formatDuration(runDurationMs)}`);
  console.log(`Total experiments: ${successfulExperiments.length + failedExperiments.length}`);
  console.log(`Successful: ${successfulExperiments.length}`);
  console.log(`Failed: ${failedExperiments.length}`);

  if (successfulExperiments.length > 0) {
    console.log(`\n✓ Successful experiments:`);
    for (const name of successfulExperiments) {
      console.log(`  - ${name}`);
    }
  }

  if (failedExperiments.length > 0) {
    console.log(`\n✗ Failed experiments:`);
    for (const {name, error} of failedExperiments) {
      console.log(`  - ${name}`);
      console.log(`    Error: ${error.message || error}`);
    }
  }

  console.log(`\n========================================\n`);
}


main().then(() => {
  console.log("Execution completed");
  process.exit(0);
}).catch((error) => {
  console.error("Execution failed: ", error);
  process.exit(1);
});


/*
runExperiment("test-experiment-1", {
  "type": "watchparty-overview-page",
  "podsPerServer": 30,
  "iterations": [
    {
      "iterationName": "number-of-joined-watchparties",
      "args": [
        [10],
        [20],
        [100],
      ]
    }
  ],
}, false, true, {
  aggregator: "error",
  uma: "error",
  css: "error"
}).then((result) => {
  for (const res of result) {
    res.print();
  }
  console.log("Experiment completed");
}).catch((error) => {
  console.error("Experiment failed: ", error);
});

/*
runExperiment("test-experiment-2", {
  "type": "watchparty-watch-page",
  "podsPerServer": 30,
  "iterations": [
    {
      "iterationName": "test",
      "args": [
        // [ numberOfMembers, numberOfMessagesPerMember ]
        [10, 10],
        [100, 10],
        [10, 10],
        [10, 100],
      ]
    }
  ],
}, false, false).then((result) => {
  for (const res of result) {
    res.print();
  }
  console.log("Experiment completed");
}).catch((error) => {
  console.error("Experiment failed: ", error);
});


runExperiment("test-experiment-3", {
  "type": "elevate-activity-page",
  "podsPerServer": 30,
  "iterations": [
    {
      "iterationName": "activity-complexity",
      "args": [
        ["minimal"],
        ["simple"],
        ["normal"],
        ["complex"]
      ]
    }
  ]
}, false, false).then((result) => {
  for (const res of result) {
    res.print();
  }
  console.log("Experiment completed");
}).catch((error) => {
  console.error("Experiment failed: ", error);
});

/*
runExperiment("test-experiment-4", {
  "type": "elevate-activities-page",
  "podsPerServer": 30,
  "iterations": [
    {
      "iterationName": "activities-complexity",
      "args": [
        ["complex", "minimal", 10],
        ["complex", "minimal", 300],
        ["complex", "normal", 10],
        ["complex", "normal", 200],
        ["complex", "complex", 10],
        ["complex", "complex", 60]
      ]
    }

  ]
}, false, false, {
  experiment: "info",
  aggregator: "debug",
  uma: "warn",
}).then((result) => {
  for (const res of result) {
    res.print();
  }
  console.log("Experiment completed");
}).catch((error) => {
  console.error("Experiment failed: ", error);
});


runExperiment("test-experiment-5", {
  "type": "elevate-fitness-trend-page",
  "podsPerServer": 30,
  "iterations": [
    {
      "iterationName": "activities-count",
      "args": [
        ["complex", "fitness-trend", 2],
      ]
    }
  ]
}, false, false).then((result) => {
  for (const res of result) {
    res.print();
  }
  console.log("Experiment completed");
}).catch((error) => {
  console.error("Experiment failed: ", error);
});

runExperiment("test-experiment-6", {
  "type": "elevate-yearly-progression-page",
  "podsPerServer": 30,
  "iterations": [
    {
      "iterationName": "activities-count",
      "args": [
        ["complex", "year-progress", 1],
        ["complex", "year-progress", 5],
        ["complex", "year-progress", 10],
      ]
    }
  ]
}, false, false).then((result) => {
  for (const res of result) {
    res.print();
  }
  console.log("Experiment completed");
}).catch((error) => {
  console.error("Experiment failed: ", error);
});
*/
