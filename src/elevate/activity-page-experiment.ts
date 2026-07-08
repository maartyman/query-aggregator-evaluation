import type {Experiment} from "../experiment";
import {ExperimentSetup, PodContext} from "../data-generator";
import {ActivityGeneratorOptions, ElevateDataGenerator, ComplexityMap} from "./generate-data-elevate";
import {ExperimentResult} from "../utils/result-builder";
import type {PhaseTiming} from "../utils/result-builder";
import {Logger} from "../utils/logger";
import {isMainThread, parentPort, Worker, workerData} from "worker_threads";
import {Auth} from "../utils/auth";
import {ActivityDao} from "./utils/activity.dao";
import fs from "node:fs";
import path from "node:path";
import {CachingStrategy} from "../utils/caching-strategy";
import {IndexedStore} from "../utils/indexed-store";
import {createMeasuredFetch, getHttpMetricsSnapshot, resetHttpMetrics} from "../utils/http-metrics";

async function withResultRetry<T>(
  fn: () => Promise<T>,
  { retries = 5, delayMs = 300 }: { retries?: number; delayMs?: number } = {}
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      const isTransientEmpty = String(error?.message ?? error).includes("No results received from iterator");
      if (!isTransientEmpty || attempt === retries) {
        throw error;
      }
      Logger.warn(
        `Query returned no results (attempt ${attempt + 1}/${retries + 1}); retrying after ${delayMs}ms...`
      );
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

async function runQueriesInWorker(podContext: PodContext, activityLocation: string, cache: CachingStrategy, authorizationMode = "nondelegated"): Promise<ExperimentResult> {
  const auth = authorizationMode === "no-auth" ? undefined : new Auth(podContext, {enableCache: false});
  await auth?.init();
  await auth?.getAccessToken();
  const resourceFetch = auth ? auth.fetch.bind(auth) : createMeasuredFetch();
  const queryFetch = resourceFetch;

  const activityUrl = `${podContext.baseUrl}/activities/${activityLocation}`;
  const activityIri = `${activityUrl}#activity`;

  const activityDao = new ActivityDao();

  if (cache === "indexed-cache") {
    return await withResultRetry(async () => {
      const store = new IndexedStore();
      await store.add([activityUrl], resourceFetch);

      const setupHttpMetrics = await getHttpMetricsSnapshot();
      const startTime = ExperimentResult.startMeasurement();

      const resultIterator = await activityDao.getById(activityIri, {
        auth,
        fetch: queryFetch,
        sources: [store.get(activityUrl)] as any
      });

      return await ExperimentResult.fromIterator(
        podContext.name + "_" + activityLocation + "_" + cache,
        startTime,
        resultIterator,
        { setupHttpMetrics, numberOfTriples: store.countQuads() }
      );
    });
  }

  return await withResultRetry(async () => {
    const setupHttpMetrics = await getHttpMetricsSnapshot();
    const startTime = ExperimentResult.startMeasurement();

    const resultIterator = await activityDao.getById(activityIri, {
      auth,
      fetch: queryFetch,
      sources: [activityUrl]
    });

    return await ExperimentResult.fromIterator(
      podContext.name + "_" + activityLocation + "_" + cache,
      startTime,
      resultIterator,
      { setupHttpMetrics }
    );
  });
}

export class ActivityPageExperiment extends ElevateDataGenerator implements Experiment {
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
        enableCache: true,
        expectedBindings: 1
      },
      auth: auth
    });

    // Mark as initialized for this pod/activity combination
    this.aggregatorIdStore.set(cacheKey, 'initialized');
  }

  private async waitForDelegatedAggregatorAuthorization(podContext: PodContext, activityLocation: string): Promise<void> {
    if (this.experimentConfig.authorizationMode !== "delegated") {
      return;
    }

    const activityUrl = `${podContext.baseUrl}/activities/${activityLocation}`;
    const activityIri = `${activityUrl}#activity`;
    const deadline = Date.now() + 30_000;
    let lastError: unknown;

    while (Date.now() < deadline) {
      const auth = new Auth(podContext, {enableCache: false});
      await auth.init();
      await auth.getAccessToken();

      try {
        const activityDao = new ActivityDao();
        await activityDao.getById(activityIri, {
          aggregator: {
            enabled: true,
            podContext,
            enableCache: false,
            expectedBindings: 1
          },
          auth
        });

        if (auth.getDerivationClaimRequestCount() > 0) {
          return;
        }
        lastError = new Error("Aggregator service authorized without requesting upstream derivation claims.");
      } catch (error) {
        lastError = error;
      }

      await new Promise(resolve => setTimeout(resolve, 500));
    }

    throw new Error(`Delegated aggregator service did not require upstream derivation claims within 30000ms: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  generate(): ExperimentSetup {
    this.removeGeneratedData();
    const queryUsers: PodContext[] = [];
    let firstPodContext: PodContext | null = null;
    // Generate data in a dedicated pod per argument collection
    for (const iteration of this.experimentConfig.iterations) {
      for (const arg of iteration.args) {
        const optionValues = Object.values(arg).map(v => String(v).toLowerCase()).join("_");
        const experimentId = `${iteration.iterationName}-${optionValues}`;
        const podContext = this.generateProfileCard(experimentId);
        queryUsers.push(podContext);
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
    return this.finalizeGeneration(queryUserContext, queryUsers);
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

  async runLocal(iterations: number): Promise<ExperimentResult[]> {
    const results: ExperimentResult[] = [];

    for (let iteration = 0; iteration < iterations; iteration++) {
      for (const iterationConfig of this.experimentConfig.iterations) {
        for (const arg of iterationConfig.args) {
          const optionValues = Object.values(arg).map(v => String(v).toLowerCase()).join("_");
          const experimentId = `${iterationConfig.iterationName}-${optionValues}`;
          const activityLocation = "activity";

          this.podContext = this.getUserPodContext(this.queryUser, experimentId);
          for (const cache of ["no-cache", "indexed-cache"] as const) {
            Logger.info(`Running local experiment for pod ${this.podContext.name}, cache ${cache}, iteration ${iteration + 1}/${iterations}`);
            await new Promise<ExperimentResult>((resolve, reject) => {
              const logLevel = Logger.getLevel()
              const worker = new Worker(__filename, {
                workerData: {logLevel, podContext: this.podContext, activityLocation, cache, authorizationMode: this.experimentConfig.authorizationMode}
              });

              worker.on('message', (message) => {
                if (message.success) {
                  const experimentResult = ExperimentResult.deserialize(message.result);
                  results.push(experimentResult);
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
        }
      }
    }
    return results;
  }

  async runAggregator(iterations: number): Promise<ExperimentResult[]> {
    return this.runAggregatorMode(iterations, false);
  }

  async runAggregatorDiscovered(iterations: number): Promise<ExperimentResult[]> {
    return this.runAggregatorMode(iterations, true);
  }

  private async runAggregatorMode(iterations: number, discover: boolean): Promise<ExperimentResult[]> {
    const results: ExperimentResult[] = [];

    for (let iteration = 0; iteration < iterations; iteration++) {
      for (const iterationConfig of this.experimentConfig.iterations) {
        for (const arg of iterationConfig.args) {
          const optionValues = Object.values(arg).map(v => String(v).toLowerCase()).join("_");
          const experimentId = `${iterationConfig.iterationName}-${optionValues}`;
          const activityLocation = "activity";

          this.podContext = this.getUserPodContext(this.queryUser, experimentId);

          for (const cache of ["no-cache"]) {
            Logger.info(`Running ${discover ? "discovered aggregator" : "aggregator"} experiment for pod ${this.podContext.name}, iteration ${iteration + 1}/${iterations}`);

            await this.setupAggregator(this.podContext, activityLocation);
            await this.waitForDelegatedAggregatorAuthorization(this.podContext, activityLocation);

            const auth = new Auth(this.podContext, {enableCache: false});
            await auth.init();
            await auth.getAccessToken();

            resetHttpMetrics();
            const setupHttpMetrics = await getHttpMetricsSnapshot();
            const startTime = ExperimentResult.startMeasurement();

            const activityUrl = `${this.podContext.baseUrl}/activities/${activityLocation}`;
            const activityIri = `${activityUrl}#activity`;
            const activityDao = new ActivityDao();
            const phaseTimings: PhaseTiming[] = [];
            const serviceAlternativeCounts: number[] = [];

            const activities = await activityDao.getById(activityIri, {
              aggregator: {
                enabled: true,
                podContext: this.podContext,
                enableCache: false,
                discover,
                expectedBindings: 1,
                phaseTimings,
                serviceAlternativeCounts
              },
              auth
            });

            const aggregatorResultJson = {
              results: {
                bindings: Array.isArray(activities)
                  ? activities.map((activity: any) => {
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

            const aggregatorResult = await ExperimentResult.fromJson(
              this.podContext.name + "_" + activityLocation + (discover ? "_aggregator_discovered" : "_aggregator"),
              startTime,
              aggregatorResultJson,
              {
                setupHttpMetrics,
                derivationClaimRequests: auth.getDerivationClaimRequestCount(),
                serviceAlternatives: serviceAlternativeCounts.length > 0 ? Math.max(...serviceAlternativeCounts) : 0,
                serviceAlternativeCounts,
              },
              phaseTimings
            );
            results.push(aggregatorResult);

            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
      }
    }
    return results;
  }
}

if (!isMainThread && parentPort) {
  Logger.setLevel(workerData.logLevel);
  runQueriesInWorker(workerData.podContext, workerData.activityLocation, workerData.cache, workerData.authorizationMode)
    .then((result: ExperimentResult) => {
      parentPort!.postMessage({ success: true, result: result.serialize() });
    })
    .catch((error: any) => {
      parentPort!.postMessage({ success: false, error: error.message });
    });
}
