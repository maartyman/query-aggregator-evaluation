import {startServers, stopServers} from "./utils/server-functions";
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
  derivedClaims?: boolean;
  iterations: Array<{
    iterationName: string;
    args: any[][];
  }>;
  podsPerServer?: number;
}

export interface Config {
  podsPerServer: number;
  useExistingData?: boolean;
  experiments: Record<string, ExperimentConfig>;
}

const WARMUP_RUNS = 1;
const RECORDED_RUNS = 30;

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
  derivedClaims: boolean,
  loggingOptions?: LoggingOptions
): Promise<ExperimentResult[]> {
  if (loggingOptions?.experiment) {
    Logger.setLevel(loggingOptions.experiment);
  }

  const experimentLocation = path.resolve(`./experiment-data/${experimentName}`);
  let experiment: Experiment | null = null;
  let setup: ExperimentSetup | null = null;

  const configWithDerivedClaims = {
    ...experimentConfig,
    derivedClaims,
    podsPerServer: experimentConfig.podsPerServer
  };

  switch (experimentConfig.type) {
    case "watchparty-overview-page":
      experiment = new OverviewPageExperiment(experimentLocation, configWithDerivedClaims);
      break;
    case "watchparty-watch-page":
      experiment = new WatchPageExperiment(experimentLocation, configWithDerivedClaims);
      break;
    case "elevate-activity-page":
      experiment = new ActivityPageExperiment(experimentLocation, configWithDerivedClaims);
      break;
    case "elevate-activities-page":
      experiment = new ActivitiesPageExperiment(experimentLocation, configWithDerivedClaims);
      break;
    case "elevate-fitness-trend-page":
      experiment = new ActivitiesPageExperiment(experimentLocation, configWithDerivedClaims);
      break;
    case "elevate-yearly-progression-page":
      experiment = new ActivitiesPageExperiment(experimentLocation, configWithDerivedClaims);
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

  await startServers(
    path.resolve("../user-managed-access/packages/uma"),
    path.resolve("../user-managed-access/packages/css"),
    path.resolve("../aggregator"),
    experimentLocation,
    derivedClaims,
    setup.servers,
    setup.queryUser,
    loggingOptions
  );

  getAggregatorIdStore().clear();

  try {
    console.log(`Running ${WARMUP_RUNS} warmup run(s) for local conditions...`);
    await experiment.runLocal(WARMUP_RUNS);
    console.log(`Running ${WARMUP_RUNS} warmup run(s) for aggregator conditions...`);
    await experiment.runAggregator(WARMUP_RUNS);

    console.log(`Running ${RECORDED_RUNS} recorded run(s) for local conditions...`);
    const resultsLocal = await experiment.runLocal(RECORDED_RUNS);
    console.log(`Running ${RECORDED_RUNS} recorded run(s) for aggregator conditions...`);
    const resultsAggregator = await experiment.runAggregator(RECORDED_RUNS);

    return [...resultsLocal, ...resultsAggregator];
  } finally {
    await stopServers();
  }
}

async function main() {
  const configPath = path.resolve('./configs/complete-config.json');

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

  for (const [experimentName, experimentConfig] of Object.entries(config.experiments)) {
    console.log(`\n========================================`);
    console.log(`Starting experiment: ${experimentName}`);
    console.log(`========================================\n`);

    const podsPerServer = experimentConfig.podsPerServer ?? config.podsPerServer;
    const configWithPods = { ...experimentConfig, podsPerServer };

    const derivedClaimsValues: boolean[] =
      experimentConfig.derivedClaims === undefined
        ? [false, true]
        : [experimentConfig.derivedClaims];

    for (const derivedClaims of derivedClaimsValues) {
      const suffix = experimentConfig.derivedClaims === undefined
        ? (derivedClaims ? '-derived' : '-nonderived')
        : '';

      const fullExperimentName = `${experimentName}${suffix}`;

      console.log(`Running ${fullExperimentName} (derivedClaims: ${derivedClaims})...`);

      try {
        const results = await runExperiment(
          experimentName,
          configWithPods,
          config.useExistingData ?? false,
          derivedClaims
        );

        const resultRunCounts = new Map<string, number>();

        for (const result of results) {
          try {
            if (!result.parameters) {
              result.parameters = {};
            }

            result.parameters.experimentName = experimentName;
            result.parameters.experimentType = experimentConfig.type;
            result.parameters.derivedClaims = derivedClaims;
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
              const cacheIndex = idParts.indexOf('aggregator') + 1;
              if (cacheIndex < idParts.length) {
                result.parameters.cacheStrategy = idParts[cacheIndex];
              }
            } else {
              result.parameters.useAggregator = false;
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
            console.log(`Saved result to: ${resultPath}`);
            result.print();
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

  console.log(`\n========================================`);
  console.log(`EXPERIMENT SUMMARY`);
  console.log(`========================================`);
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
