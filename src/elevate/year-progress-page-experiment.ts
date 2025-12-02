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
import {CachingStrategy} from "../utils/caching-strategy";

async function runQueriesInWorker(
  podContext: PodContext,
  activityLocations: string[],
  cache: CachingStrategy
): Promise<ExperimentResult> {
  const auth = new Auth(podContext, {enableCache: (cache !== "none")});
  await auth.init();
  await auth.getAccessToken();

  const activitySources = activityLocations.map(location =>
    `${podContext.baseUrl}/activities/${location}`
  );

  const activityDao = new ActivityDao();

  const runQuery = async () => {
    return await activityDao.find({
      sources: activitySources,
      keys: [
        "activity_startTime",
        "activity_type",
        "activity_trainer",
        "activity_commute",
        "activity_stats_distance",
        "activity_stats_movingTime",
        "activity_stats_elevationGain"
      ],
      auth
    });
  };

  if (cache === "indexed") {
    const it = await runQuery();
    if (typeof it === 'object' && 'destroy' in it && typeof it.destroy === 'function') {
      it.destroy();
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  const startTime = process.hrtime();
  const resultIterator = await runQuery();

  return await ExperimentResult.fromIterator(
    podContext.name + "_" + cache,
    startTime,
    resultIterator
  );
}

export class YearProgressPageExperiment extends ElevateDataGenerator implements Experiment {
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

  private async setupAggregator(
    podContext: PodContext,
    activityLocations: string[]
  ): Promise<void> {
    // Check if we already have an aggregator service for this query
    const cacheKey = `${podContext.name}_${activityLocations.length}`;
    if (this.aggregatorIdStore.has(cacheKey)) {
      return;
    }

    // Build activity sources from locations
    const activitySources = activityLocations.map(location =>
      `${podContext.baseUrl}/activities/${location}`
    );

    const activityDao = new ActivityDao();

    // This will create the aggregator service and store the ID
    const auth = new Auth(podContext, {enableCache: true});
    await auth.init();
    await auth.getAccessToken();
    await activityDao.find({
      sources: activitySources,
      keys: [
        "activity_startTime",
        "activity_type",
        "activity_trainer",
        "activity_commute",
        "activity_stats_distance",
        "activity_stats_movingTime",
        "activity_stats_elevationGain"
      ],
      aggregator: {
        enabled: true,
        podContext: podContext,
        enableCache: true
      },
      auth: auth
    });

    // Mark as initialized for this pod/query combination
    this.aggregatorIdStore.set(cacheKey, 'initialized');
  }

  generate(): ExperimentSetup {
    this.removeGeneratedData();
    let firstPodContext: PodContext | null = null;
    // Generate data in a dedicated pod per argument collection
    for (const iteration of this.experimentConfig.iterations) {
      for (const arg of iteration.args) {
        // arg[0] = complexity, arg[1] = numberOfActivities
        const complexity = arg[0];
        const numberOfActivities = arg[1];

        const optionValues = Object.values(arg).map(v => String(v).toLowerCase()).join("_");
        const experimentId = `${iteration.iterationName}-${optionValues}`;
        const podContext = this.generateProfileCard(experimentId);

        const options: ActivityGeneratorOptions = ComplexityMap[complexity];
        if (!options) {
          throw new Error(`No scenario found for argument: ${complexity}`);
        }

        // Generate multiple activities
        for (let i = 0; i < numberOfActivities; i++) {
          this.generateActivity(podContext, `activity-${i}`, options);
        }

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
          // arg[0] = complexity, arg[1] = numberOfActivities
          const complexity = arg[0];
          const numberOfActivities = arg[1];

          // Generate pod name matching the structure used in generate()
          const optionValues = Object.values(arg).map(v => String(v).toLowerCase()).join("_");
          const experimentId = `${iterationConfig.iterationName}-${optionValues}`;

          // Build activity locations array
          const activityLocations: string[] = [];
          for (let i = 0; i < numberOfActivities; i++) {
            activityLocations.push(`activity-${i}`);
          }

          // Initialize podContext for this iteration using the correct pod name
          this.podContext = this.getUserPodContext(this.queryUser, experimentId);

          for (const cache of ["none", "tokens", "indexed"]) {
            Logger.info(`Running experiment for pod ${this.podContext.name}, cache ${cache}, iteration ${iteration + 1}/${iterations}`);
            await new Promise<ExperimentResult>((resolve, reject) => {
              const worker = new Worker(__filename, {
                workerData: {podContext: this.podContext, activityLocations, cache}
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
          }

          for (const cache of ["none", "tokens"]) {
            Logger.info(`Running experiment for pod ${this.podContext.name}, aggregator, cache ${cache}, iteration ${iteration + 1}/${iterations}`);
            await this.setupAggregator(this.podContext, activityLocations);

            const auth = new Auth(this.podContext, {enableCache: cache !== "none"});
            await auth.init();
            await auth.getAccessToken();

            const startTime = process.hrtime();

            // Query multiple activities using aggregator
            const activitySources = activityLocations.map(location =>
              `${this.podContext!.baseUrl}/activities/${location}`
            );

            const activityDao = new ActivityDao();

            const activities = await activityDao.find({
              sources: activitySources,
              keys: [
                "activity_startTime",
                "activity_type",
                "activity_trainer",
                "activity_commute",
                "activity_stats_distance",
                "activity_stats_movingTime",
                "activity_stats_elevationGain"
              ],
              aggregator: {
                enabled: true,
                podContext: this.podContext,
                enableCache: cache !== "none"
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
              this.podContext.name + "_aggregator_" + cache,
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
  runQueriesInWorker(workerData.podContext, workerData.activityLocations, workerData.cache)
    .then((result: ExperimentResult) => {
      parentPort!.postMessage({ success: true, result: result.serialize() });
    })
    .catch((error: any) => {
      parentPort!.postMessage({ success: false, error: error.message });
    });
}

