import type {Experiment} from "../experiment";
import {ExperimentSetup, PodContext} from "../data-generator";
import {ActivityGeneratorOptions, ElevateDataGenerator, ComplexityMap} from "./generate-data-elevate";
import {ExperimentResult} from "../utils/result-builder";
import {Logger} from "../utils/logger";
import {isMainThread, parentPort, Worker, workerData} from "worker_threads";
import {Auth} from "../utils/auth";
import {ActivityDao} from "./utils/activity.dao";
import fs from "node:fs";
import path from "node:path";

async function runQueriesInWorker(podContext: PodContext, activityLocation: string, cache: boolean): Promise<ExperimentResult> {
  const auth = new Auth(podContext, {enableCache: cache});
  await auth.init();
  await auth.getAccessToken();

  // The activity is stored at: podBaseUrl/activities/activityLocation
  // The activity IRI is: podBaseUrl/activities/activityLocation#activity
  const activityUrl = `${podContext.baseUrl}/activities/${activityLocation}`;
  const activityIri = `${activityUrl}#activity`;

  const activityDao = new ActivityDao();

  const startTime = process.hrtime();

  const resultIterator = await activityDao.getById(activityIri, { auth });

  return await ExperimentResult.fromIterator(
    podContext.name + "_" + activityLocation + "_" + (cache ? "cache" : "no-cache"),
    startTime,
    resultIterator
  );
}

export class ActivityScreenExperiment extends ElevateDataGenerator implements Experiment {
  protected queryUser: string;
  private podContext?: PodContext;

  constructor(
    outputDirectory: string,
    experimentConfig: any,
    distributionOptions: any = {},
    queryUser: string = "query-user"
  ) {
    super(outputDirectory, experimentConfig, distributionOptions);
    this.queryUser = queryUser;
  }

  private async setupAggregator(podContext: PodContext, activityLocation: string): Promise<void> {
    // Check if we already have an aggregator service for this activity
    const cacheKey = `${podContext.name}_${activityLocation}`;
    if (this.aggregatorIdStore.has(cacheKey)) {
      return;
    }

    // Use the aggregator-enabled query path
    // The ActivityDao.getById will use aggregator when aggregator option is provided
    // We need to call it once to initialize the aggregator service
    const activityUrl = `${podContext.baseUrl}/activities/${activityLocation}`;
    const activityIri = `${activityUrl}#activity`;

    const activityDao = new ActivityDao();

    // This will create the aggregator service and store the ID
    const auth = new Auth(podContext, {enableCache: true});
    await auth.init();
    await auth.getAccessToken();
    await activityDao.getById(activityIri, {
      aggregator: {
        enabled: true,
        podContext: podContext,
        enableCache: true
      },
      auth: auth
    });

    // Mark as initialized for this pod/activity combination
    this.aggregatorIdStore.set(cacheKey, 'initialized');
  }

  generate(): ExperimentSetup {
    this.removeGeneratedData();
    let firstPodContext: PodContext | null = null;
    // Generate data in a dedicated pod per argument collection
    for (const iteration of this.experimentConfig.iterations) {
      for (const arg of iteration.args) {
        const optionValues = Object.values(arg).map(v => String(v).toLowerCase()).join("_");
        const experimentId = `${iteration.iterationName}-${optionValues}`;
        let podContext = this.generateProfileCard(experimentId);
        const options: ActivityGeneratorOptions = ComplexityMap[arg[0]];
        if (!options) {
          throw new Error(`No scenario found for argument: ${arg[0]}`);
        }
        this.generateActivity(podContext, "activity", options);
        if (!firstPodContext) {
          firstPodContext = podContext;
        }
      }
    }
    const queryUserContext = this.getOrCreatePodContext(firstPodContext!.name);
    return this.finalizeGeneration(queryUserContext);
  }

  private generateProfileCard(experimentId: string): PodContext {
    const queryUserContext = this.getUserPodContext(this.queryUser, experimentId);
    const queryUserPodUrl = queryUserContext.baseUrl;
    const queryUserRelativePath = queryUserContext.relativePath;
    const cardTriples = `@prefix foaf: <http://xmlns.com/foaf/0.1/>.
@prefix solid: <http://www.w3.org/ns/solid/terms#>.

<>
    a foaf:PersonalProfileDocument;
    foaf:maker <${queryUserPodUrl}/profile/card#me>;
    foaf:primaryTopic <${queryUserPodUrl}/profile/card#me>.

<${queryUserPodUrl}/profile/card#me>
    solid:oidcIssuer <${queryUserContext.server.solidBaseUrl}>;
    a foaf:Person.
`;
    const cardFilePath = `${this.outputDirectory}/${queryUserRelativePath}/profile/card$.ttl`;
    fs.mkdirSync(path.dirname(cardFilePath), { recursive: true });
    fs.writeFileSync(cardFilePath, cardTriples);
    return queryUserContext;
  }

  async run(saveResults: boolean, iterations: number): Promise<void> {
    const results: ExperimentResult[] = [];

    for (let iteration = 0; iteration < iterations; iteration++) {
      for (const iterationConfig of this.experimentConfig.iterations) {
        for (const arg of iterationConfig.args) {
          // Generate pod name matching the structure used in generate()
          const optionValues = Object.values(arg).map(v => String(v).toLowerCase()).join("_");
          const experimentId = `${iterationConfig.iterationName}-${optionValues}`;
          const activityLocation = "activity";

          // Initialize podContext for this iteration using the correct pod name
          this.podContext = this.getUserPodContext(this.queryUser, experimentId);
          for (const cache of [false, true]) {
            Logger.info(`Running experiment for pod ${this.podContext.name}, cache ${cache}, iteration ${iteration + 1}/${iterations}`);
            await new Promise<ExperimentResult>((resolve, reject) => {
              const worker = new Worker(__filename, {
                workerData: {podContext: this.podContext, activityLocation, cache}
              });

              worker.on('message', (message) => {
                if (message.success) {
                  const experimentResult = ExperimentResult.deserialize(message.result);
                  results.push(experimentResult);
                  if (saveResults) {
                    experimentResult.print();
                  }
                  resolve(experimentResult);
                } else {
                  reject(new Error(message.error));
                }
                worker.terminate();
              });

              worker.on('error', (error) => {
                console.error(`Worker error for ${this.podContext!.name}:`, error);
                reject(error);
              });

              worker.on('exit', (code) => {
                if (code !== 0) {
                  // Worker stopped with non-zero exit code
                }
              });
            });

            await new Promise(resolve => setTimeout(resolve, 100));

            Logger.info(`Running experiment for pod ${this.podContext.name}, aggregator, cache ${cache}, iteration ${iteration + 1}/${iterations}`);
            await this.setupAggregator(this.podContext, activityLocation);

            const auth = new Auth(this.podContext, {enableCache: cache});
            await auth.init();
            await auth.getAccessToken();

            const startTime = process.hrtime();

            // Query the activity using aggregator
            const activityUrl = `${this.podContext.baseUrl}/activities/${activityLocation}`;
            const activityIri = `${activityUrl}#activity`;
            const activityDao = new ActivityDao();

            const activities = await activityDao.getById(activityIri, {
              aggregator: {
                enabled: true,
                podContext: this.podContext,
                enableCache: cache
              },
              auth
            });

            // Convert activities result to JSON format for result builder
            const aggregatorResultJson = {
              results: {
                bindings: Array.isArray(activities)
                  ? activities.map((activity: any) => {
                      // Convert Activity object to JSON bindings format
                      const binding: any = {};
                      for (const [key, value] of Object.entries(activity)) {
                        if (value !== null && value !== undefined) {
                          binding[key] = {
                            type: 'literal',
                            value: typeof value === 'object' ? JSON.stringify(value) : String(value)
                          };
                        }
                      }
                      return binding;
                    })
                  : []
              }
            };

            const aggregatorResult = ExperimentResult.fromJson(
              this.podContext.name + "_" + activityLocation + "_aggregator_" + (cache ? "cache" : "no-cache"),
              startTime,
              aggregatorResultJson
            );
            results.push(aggregatorResult);
            if (saveResults) {
              aggregatorResult.print();
            }

            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
      }
    }
  }
}

if (!isMainThread && parentPort) {
  runQueriesInWorker(workerData.podContext, workerData.activityLocation, workerData.cache)
    .then((result: ExperimentResult) => {
      parentPort!.postMessage({ success: true, result: result.serialize() });
    })
    .catch((error: any) => {
      parentPort!.postMessage({ success: false, error: error.message });
    });
}
