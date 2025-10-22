import {startServers, stopServers} from "./server-functions";
import * as path from 'path';
import {OverviewPageExperiment} from "./watch-party/overview-page-experiment";
import {WatchPageExperiment} from "./watch-party/watch-page-experiment";

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

async function runExperiment(experimentName: string, experimentConfig: any) {
  const experimentLocation = path.resolve(`./experiment-data/${experimentName}`);
  // generate the data
  let experiment: Experiment | null = null;
  switch (experimentConfig.type) {
    case "watchparty-overview-page":
      experiment = new OverviewPageExperiment(experimentLocation, experimentConfig);
      break;
    case "watchparty-watch-page":
      //experiment = new WatchPageExperiment(experimentLocation, experimentConfig);
      break;
    default:
      throw new Error(`Unknown experiment type: ${experimentConfig.type}`);
  }
  if (!experiment) {
    throw new Error(`Could not create experiment of type: ${experimentConfig.type}`);
  }
  // generate the data
  const query_user = experiment.generate();
  // start the servers

  await startServers(
    "/home/maarten/Documents/doctoraat/code/original-uma/packages/uma",
    "/home/maarten/Documents/doctoraat/code/original-uma/packages/css",
    "/home/maarten/Documents/doctoraat/code/aggregator",
    experimentLocation,
    query_user
  );
  await experiment.setupAggregators();

  await experiment.run(true, 1);

  stopServers();
}

runExperiment("test-experiment-1", {
  "type": "watchparty-overview-page",
  "iterations": [
    {
      "iterationName": "number-of-joined-watchparties",
      "args": [
        [1],
      ]
    }
  ]
}).then(() => {
  console.log("Experiment completed");
}).catch((error) => {
  console.error("Experiment failed: ", error);
});

/*
runExperiment("test-experiment-2", {
  "type": "watchparty-watch-page",
  "iterations": [
    {
      "iterationName": "number-of-joined-watchparties",
      "args": [
      // [ numberOfMembers, numberOfMessagesPerMember ]
        [10, 1],
        [50, 1],
        [100, 1],
      ]
    }
  ]
});
*/
