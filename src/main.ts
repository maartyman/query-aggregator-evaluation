import {startServers, stopServers} from "./utils/server-functions";
import * as path from 'path';
import type {Experiment} from "./experiment";
import type {ExperimentSetup} from "./data-generator";
import {OverviewPageExperiment} from "./watch-party/overview-page-experiment";
import {WatchPageExperiment} from "./watch-party/watch-page-experiment";
import {Auth} from "./utils/auth";
import {Logger, type LogLevel} from './utils/logger';
import {ActivityScreenExperiment} from "./elevate/activity-screen-experiment";
import {ElevateSport} from "./elevate/utils/elevate-types";
import {getAggregatorIdStore} from "./utils/aggregator-id-store";
import {ActivitiesScreenExperiment} from "./elevate/activities-screen-experiment";
import {FitnessTrendScreenExperiment} from "./elevate/fitness-trend-screen-experiment";
import {YearProgressScreenExperiment} from "./elevate/year-progress-screen-experiment";
import {CountExperiment} from "./elevate/count-experiment";

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

async function runExperiment(experimentName: string, experimentConfig: any, debug?: string) {
  // Configure logger level based on debug flag
  if (debug) {
    const level = (debug.toLowerCase() as LogLevel);
    Logger.setLevel(level);
  }

  const experimentLocation = path.resolve(`./experiment-data/${experimentName}`);
  let experiment: Experiment | null = null;
  let setup: ExperimentSetup | null = null;
  switch (experimentConfig.type) {
    case "watchparty-overview-page":
      experiment = new OverviewPageExperiment(experimentLocation, experimentConfig);
      break;
    case "watchparty-watch-page":
      experiment = new WatchPageExperiment(experimentLocation, experimentConfig);
      break;
    case "elevate-activity-screen":
      experiment = new ActivityScreenExperiment(experimentLocation, experimentConfig);
      break;
    case "elevate-activities-screen":
      experiment = new ActivitiesScreenExperiment(experimentLocation, experimentConfig);
      break;
    case "elevate-fitness-trend-screen":
      experiment = new FitnessTrendScreenExperiment(experimentLocation, experimentConfig);
      break;
    case "elevate-yearly-progression-screen":
      experiment = new YearProgressScreenExperiment(experimentLocation, experimentConfig);
      break;
    case "elevate-count":
      experiment = new CountExperiment(experimentLocation, experimentConfig);
      break;
    default:
      throw new Error(`Unknown experiment type: ${experimentConfig.type}`);
  }
  if (!experiment) {
    throw new Error(`Could not create experiment of type: ${experimentConfig.type}`);
  }

  await Auth.resetCache();
  setup = experiment.generate();

  await startServers(
    "/home/maarten/Documents/doctoraat/code/original-uma/packages/uma",
    "/home/maarten/Documents/doctoraat/code/original-uma/packages/css",
    "/home/maarten/Documents/doctoraat/code/aggregator",
    experimentLocation,
    experimentConfig.derivedClaims,
    setup.servers,
    setup.queryUser,
    debug
  );

  getAggregatorIdStore().clear()

  await experiment.run(false, 2);

  await experiment.run(true, 1);

  stopServers();
}

/*
runExperiment("test-experiment-1", {
  "type": "watchparty-overview-page",
  "derivedClaims": false,
  "iterations": [
    {
      "iterationName": "number-of-joined-watchparties",
      "args": [
        [1],
      ]
    }
  ],
  "podsPerServer": 30
}).then(() => {
  console.log("Experiment completed");
}).catch((error) => {
  console.error("Experiment failed: ", error);
});

runExperiment("test-experiment-2", {
  "type": "watchparty-watch-page",
  "derivedClaims": false,
  "iterations": [
    {
      "iterationName": "number-of-joined-watchparties",
      "args": [
      // [ numberOfMembers, numberOfMessagesPerMember ]
        [10, 1],
      ]
    }
  ],
  "podsPerServer": 30
}, "warn").then(() => {
  console.log("Experiment completed");
}).catch((error) => {
  console.error("Experiment failed: ", error);
});
*/

/*
runExperiment("test-experiment-3", {
  "type": "elevate-activity-screen",
  "derivedClaims": false,
  "iterations": [
    {
      "iterationName": "activity-complexity",
      "args": [
        ["minimum"],
        ["simple"],
        ["complex"]
      ]
    }
  ],
  "podsPerServer": 30
}).then(() => {
  console.log("Experiment completed");
}).catch((error) => {
  console.error("Experiment failed: ", error);
});
 */

runExperiment("test-experiment-4", {
  "type": "elevate-activities-screen",
  "derivedClaims": false,
  "iterations": [
    {
      "iterationName": "activities-count",
      "args": [
        ["minimal", "minimal", 1],
        ["minimal", "minimal", 10],
        ["minimal", "minimal", 20],
        ["minimal", "minimal", 30],
      ]
    },
    /*
    {
      "iterationName": "activities-complexity",
      "args": [
        ["complex", "minimal", 10],
        ["complex", "normal", 10],
        ["complex", "complex", 10],
      ]
    }
     */
  ],
  "podsPerServer": 30
}).then(() => {
  console.log("Experiment completed");
}).catch((error) => {
  console.error("Experiment failed: ", error);
});

/*
runExperiment("test-experiment-5", {
  "type": "elevate-fitness-trend-screen",
  "derivedClaims": false,
  "iterations": [
    {
      "iterationName": "activities-count",
      "args": [
        ["complex", 1],
        ["complex", 5],
        ["complex", 10],
      ]
    }
  ],
  "podsPerServer": 30
}).then(() => {
  console.log("Experiment completed");
}).catch((error) => {
  console.error("Experiment failed: ", error);
});

runExperiment("test-experiment-6", {
  "type": "elevate-yearly-progression-screen",
  "derivedClaims": false,
  "iterations": [
    {
      "iterationName": "activities-count",
      "args": [
        ["complex", 1],
        ["complex", 5],
        ["complex", 10],
      ]
    }
  ],
  "podsPerServer": 30
}).then(() => {
  console.log("Experiment completed");
}).catch((error) => {
  console.error("Experiment failed: ", error);
});

runExperiment("test-experiment-7", {
  "type": "elevate-count",
  "derivedClaims": false,
  "iterations": [
    {
      "iterationName": "activities-count",
      "args": [
        ["complex", 1],
        ["complex", 5],
        ["complex", 10],
      ]
    }
  ],
  "podsPerServer": 30
}).then(() => {
  console.log("Experiment completed");
}).catch((error) => {
  console.error("Experiment failed: ", error);
});
*/
