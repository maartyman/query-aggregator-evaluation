import {startServers, stopServers} from "./server-functions";
import * as path from 'path';
import {OverviewPageExperiment} from "./watch-party/overview-page-experiment";
import {WatchPageExperiment} from "./watch-party/watch-page-experiment";

async function runExperiment(experimentName: string, experimentConfig: any) {
  const experimentLocation = path.resolve(`./experiment-data/${experimentName}`);
  // generate the data
  let experiment: Experiment | null = null;
  switch (experimentConfig.type) {
    case "watchparty-overview-page":
      experiment = new OverviewPageExperiment(experimentLocation, experimentConfig);
      break;
    case "watchparty-watch-page":
      experiment = new WatchPageExperiment(experimentLocation, experimentConfig);
      break;
    default:
      throw new Error(`Unknown experiment type: ${experimentConfig.type}`);
  }
  if (!experiment) {
    throw new Error(`Could not create experiment of type: ${experimentConfig.type}`);
  }
  // generate the data
/*
  experiment.generate();
  // start the servers
  let servers = await startServers(
    "/home/maarten/Documents/doctoraat/code/original-uma/packages/uma",
    "/home/maarten/Documents/doctoraat/code/original-uma/packages/css",
    experimentLocation
  );*/

  // warmup
  await experiment.run(false, 2);
  // run the actual experiment
  await experiment.run(true, 1);

  //await stopServers(servers);
}

/*
runExperiment("test-experiment-1", {
  "type": "watchparty-overview-page",
  "iterations": [
    {
      "iterationName": "number-of-joined-watchparties",
      "args": [
        [1],
        [2],
        [4],
        [8],
        [16],
        [32],
      ]
    }
  ]
});
*/

runExperiment("test-experiment-2", {
  "type": "watchparty-watch-page",
  "iterations": [
    {
      "iterationName": "number-of-joined-watchparties",
      "args": [
        [1, 1],
        [2, 2],
        [4, 4],
      ]
    }
  ]
});

