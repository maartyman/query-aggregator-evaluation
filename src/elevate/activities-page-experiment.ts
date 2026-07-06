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
import {AsyncIterator} from "asynciterator";
import {IndexedStore} from "../utils/indexed-store";
import {createMeasuredFetch, getHttpMetricsSnapshot, resetHttpMetrics} from "../utils/http-metrics";

const availableServiceRel = "https://w3id.org/aggregator#availableService";

const SelectedColumnsMap: Record<string, {
  keys: string[],
  filterKeys: ({ key: string; relationKeyToValue: string; value: string | number | Date | boolean } | { requiredKeys: string[]; condition: string })[],
  sort?: { key: string; ascending: boolean }
}> = {
  "minimal": {
    keys: ["activity_startTime", "activity_name"],
    filterKeys: [],
    sort: { key: "activity_startTime", ascending: true }
  },
  "normal": {
    keys: ["activity_startTime", "activity_name", "activity_type", "activity_stats_distance",
      "activity_stats_movingTime", "activity_stats_scores_stress_hrss"
    ],
    filterKeys: [],
    sort: { key: "activity_startTime", ascending: true }
  },
  "complex": {
    keys: ["activity_startTime", "activity_name", "activity_laps", "activity_flags", "activity_type",
      "activity_stats_distance", "activity_stats_movingTime", "activity_stats_power_best20min",
      "activity_stats_scores_stress_pss", "activity_stats_scores_stress_pssPerHour", "activity_stats_heartRate_avg",
      "activity_stats_scores_stress_hrss", "activity_stats_scores_stress_hrssPerHour",
      "activity_athleteSnapshot_athleteSettings_maxHr", "activity_athleteSnapshot_athleteSettings_restHr",
      "activity_athleteSnapshot_athleteSettings_lthr_default", "activity_athleteSnapshot_athleteSettings_lthr_cycling",
      "activity_athleteSnapshot_athleteSettings_lthr_running", "activity_athleteSnapshot_athleteSettings_cyclingFtp",
      "activity_athleteSnapshot_athleteSettings_runningFtp", "activity_athleteSnapshot_athleteSettings_swimFtp",
      "activity_athleteSnapshot_athleteSettings_weight"
    ],
    filterKeys: [{
      requiredKeys: ["activity_name"],
      condition: `REGEX(?activity_name, "Session", "i")`
    }],
    sort: { key: "activity_startTime", ascending: true }
  },
  "fitness-trend": {
    keys: [
      "activity_name",
      "activity_startTime",
      "activity_type",
      "activity_flags",
      "activity_stats_scores_stress_trimp",
      "activity_stats_scores_stress_hrss",
      "activity_athleteSnapshot_athleteSettings_cyclingFtp",
      "activity_hasPowerMeter",
      "activity_stats_scores_stress_pss",
      "activity_athleteSnapshot_athleteSettings_runningFtp",
      "activity_stats_scores_stress_rss",
      "activity_athleteSnapshot_athleteSettings_swimFtp",
      "activity_stats_scores_stress_sss"
    ],
    filterKeys: [],
    sort: { key: "activity_startTime", ascending: true }
  },
  "year-progress": {
    keys: [
      "activity_startTime",
      "activity_type",
      "activity_trainer",
      "activity_commute",
      "activity_stats_distance",
      "activity_stats_movingTime",
      "activity_stats_elevationGain"
    ],
    filterKeys: []
  }
}

async function runQueriesInWorker(
  podContext: PodContext,
  activityLocations: string[],
  selectedColumns: string,
  cache: CachingStrategy,
  authorizationMode = "nondelegated"
): Promise<ExperimentResult> {
  const auth = authorizationMode === "no-auth" ? undefined : new Auth(podContext, {enableCache: false});
  await auth?.init();
  await auth?.getAccessToken();
  const resourceFetch = auth ? auth.fetch.bind(auth) : createMeasuredFetch();
  const queryFetch = resourceFetch;

  const columnConfig = SelectedColumnsMap[selectedColumns];
  if (!columnConfig) {
    throw new Error(`Unknown selected columns config: ${selectedColumns}`);
  }

  const activitySources = activityLocations.map(location =>
    `${podContext.baseUrl}/activities/${location}`
  );

  const activityDao = new ActivityDao();

  if (cache === "indexed-cache") {
    const store = new IndexedStore();
    await store.add(activitySources, resourceFetch);

    const setupHttpMetrics = await getHttpMetricsSnapshot();
    const startTime = ExperimentResult.startMeasurement();
    const mergedStore = store.getMerged(activitySources);

    await activityDao.count({
      sources: [mergedStore] as any
    });

    const resultIterator = await activityDao.find({
      sources: [mergedStore] as any,
      keys: columnConfig.keys,
      filterKeys: columnConfig.filterKeys,
      ...(columnConfig.sort && { sort: columnConfig.sort })
    });

    return await ExperimentResult.fromIterator(
      podContext.name + "_" + selectedColumns + "_" + cache,
      startTime,
      resultIterator,
      { setupHttpMetrics, numberOfTriples: store.countQuads() }
    );
  }

  const setupHttpMetrics = await getHttpMetricsSnapshot();
  const startTime = ExperimentResult.startMeasurement();

  await activityDao.count({
    sources: activitySources,
    auth,
    fetch: queryFetch
  });

  const resultIterator = await activityDao.find({
    sources: activitySources,
    keys: columnConfig.keys,
    filterKeys: columnConfig.filterKeys,
    ...(columnConfig.sort && { sort: columnConfig.sort }),
    auth,
    fetch: queryFetch
  });

  return await ExperimentResult.fromIterator(
    podContext.name + "_" + selectedColumns + "_" + cache,
    startTime,
    resultIterator,
    { setupHttpMetrics }
  );
}

export class ActivitiesPageExperiment extends ElevateDataGenerator implements Experiment {
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
    activityLocations: string[],
    selectedColumns: string
  ): Promise<void> {
    // Check if we already have an aggregator service for this query
    const cacheKey = `${podContext.name}_${selectedColumns}_${activityLocations.length}`;
    if (this.aggregatorIdStore.has(cacheKey)) {
      return;
    }

    const columnConfig = SelectedColumnsMap[selectedColumns];
    if (!columnConfig) {
      throw new Error(`Unknown selected columns config: ${selectedColumns}`);
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
    await activityDao.count({
      sources: activitySources,
      aggregator: {
        enabled: true,
        podContext: podContext,
        enableCache: true,
        expectedBindings: 1
      },
      auth: auth
    });
    await activityDao.find({
      sources: activitySources,
      keys: columnConfig.keys,
      filterKeys: columnConfig.filterKeys,
      ...(columnConfig.sort && { sort: columnConfig.sort }),
      aggregator: {
        enabled: true,
        podContext: podContext,
        enableCache: true,
        expectedBindings: activityLocations.length
      },
      auth: auth
    });

    await this.waitForDiscoveryLinks(auth, activitySources);

    // Mark as initialized for this pod/query combination
    this.aggregatorIdStore.set(cacheKey, 'initialized');
  }

  private async waitForDiscoveryLinks(auth: Auth, sources: string[]): Promise<void> {
    const timeoutMs = 30_000;
    const pollMs = 500;
    const deadline = Date.now() + timeoutMs;
    let missingSources = sources;

    while (Date.now() < deadline) {
      missingSources = [];
      for (const source of sources) {
        const response = await auth.fetch(source, { method: "HEAD" });
        if (!response.ok || !this.hasAvailableServiceLink(response.headers)) {
          missingSources.push(source);
        }
      }

      if (missingSources.length === 0) {
        return;
      }

      await new Promise(resolve => setTimeout(resolve, pollMs));
    }

    throw new Error(`Timed out waiting for aggregator discovery links on sources: ${missingSources.join(", ")}`);
  }

  private hasAvailableServiceLink(headers: Headers): boolean {
    const linkHeader = headers.get("Link");
    if (!linkHeader) {
      return false;
    }
    return linkHeader.split(",").some(link =>
      link.includes(`rel="${availableServiceRel}"`) ||
      link.includes(`rel=${availableServiceRel}`)
    );
  }

  generate(): ExperimentSetup {
    this.removeGeneratedData();
    const queryUsers: PodContext[] = [];
    let firstPodContext: PodContext | null = null;
    // Generate data in a dedicated pod per argument collection
    for (const iteration of this.experimentConfig.iterations) {
      for (const arg of iteration.args) {
        // arg[0] = complexity, arg[1] = selectedColumns, arg[2] = numberOfActivities
        const complexity = arg[0];
        const selectedColumns = arg[1];
        const numberOfActivities = arg[2];

        const optionValues = Object.values(arg).map(v => String(v).toLowerCase()).join("_");
        const experimentId = `${iteration.iterationName}-${optionValues}`;
        const podContext = this.generateProfileCard(experimentId);
        queryUsers.push(podContext);

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
          const complexity = arg[0];
          const selectedColumns = arg[1];
          const numberOfActivities = arg[2];

          const optionValues = Object.values(arg).map(v => String(v).toLowerCase()).join("_");
          const experimentId = `${iterationConfig.iterationName}-${optionValues}`;

          const activityLocations: string[] = [];
          for (let i = 0; i < numberOfActivities; i++) {
            activityLocations.push(`activity-${i}`);
          }

          this.podContext = this.getUserPodContext(this.queryUser, experimentId);

          for (const cache of ["no-cache", "indexed-cache"] as const) {
            Logger.info(`Running local experiment for pod ${this.podContext.name}, selectedColumns ${selectedColumns}, cache ${cache}, iteration ${iteration + 1}/${iterations}`);
            await new Promise<ExperimentResult>((resolve, reject) => {
              const logLevel = Logger.getLevel()
              const worker = new Worker(__filename, {
                workerData: {logLevel, podContext: this.podContext, activityLocations, selectedColumns, cache, authorizationMode: this.experimentConfig.authorizationMode}
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
          const complexity = arg[0];
          const selectedColumns = arg[1];
          const numberOfActivities = arg[2];

          const optionValues = Object.values(arg).map(v => String(v).toLowerCase()).join("_");
          const experimentId = `${iterationConfig.iterationName}-${optionValues}`;

          const activityLocations: string[] = [];
          for (let i = 0; i < numberOfActivities; i++) {
            activityLocations.push(`activity-${i}`);
          }

          this.podContext = this.getUserPodContext(this.queryUser, experimentId);

          for (const cache of ["no-cache"]) {
            Logger.info(`Running ${discover ? "discovered aggregator" : "aggregator"} experiment for pod ${this.podContext.name}, selectedColumns ${selectedColumns}, iteration ${iteration + 1}/${iterations}`);
            await this.setupAggregator(this.podContext, activityLocations, selectedColumns);

            const auth = new Auth(this.podContext, {enableCache: false});
            await auth.init();
            await auth.getAccessToken();

            resetHttpMetrics();
            const setupHttpMetrics = await getHttpMetricsSnapshot();
            const startTime = ExperimentResult.startMeasurement();

            const activitySources = activityLocations.map(location =>
              `${this.podContext!.baseUrl}/activities/${location}`
            );

            const columnConfig = SelectedColumnsMap[selectedColumns];
            if (!columnConfig) {
              throw new Error(`Unknown selected columns config: ${selectedColumns}`);
            }

            const activityDao = new ActivityDao();
            const phaseTimings: PhaseTiming[] = [];
            await activityDao.count({
              sources: activitySources,
              aggregator: {
                enabled: true,
                podContext: this.podContext,
                enableCache: false,
                discover,
                expectedBindings: 1,
                phaseTimings
              },
              auth
            });

            const activities = await activityDao.find({
              sources: activitySources,
              keys: columnConfig.keys,
              filterKeys: columnConfig.filterKeys,
              ...(columnConfig.sort && { sort: columnConfig.sort }),
              aggregator: {
                enabled: true,
                podContext: this.podContext,
                enableCache: false,
                discover,
                expectedBindings: numberOfActivities,
                phaseTimings
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
              this.podContext.name + "_" + selectedColumns + (discover ? "_aggregator_discovered" : "_aggregator"),
              startTime,
              aggregatorResultJson,
              { setupHttpMetrics },
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
  runQueriesInWorker(workerData.podContext, workerData.activityLocations, workerData.selectedColumns, workerData.cache, workerData.authorizationMode)
    .then((result: ExperimentResult) => {
      parentPort!.postMessage({ success: true, result: result.serialize() });
    })
    .catch((error: any) => {
      parentPort!.postMessage({ success: false, error: error.message });
    });
}
