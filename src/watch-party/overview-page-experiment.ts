import {WatchpartyDataGenerator} from "./generate-data-watchparty";
import * as fs from "node:fs";
import path from "node:path";
import {isMainThread, parentPort, Worker, workerData} from 'worker_threads';
import {Auth} from '../utils/auth';
import {QueryEngine} from '@comunica/query-sparql';
import {AsyncIterator, UnionIterator} from "asynciterator";
import {ExperimentResult} from "../utils/result-builder";
import {
  createAggregatorService,
  getAggregatorService,
  getDiscoveredAggregatorService,
  waitForAggregatorService
} from "../utils/aggregator-functions";
import {ExperimentSetup, PodContext} from "../data-generator";
import type {Experiment} from "../experiment";
import {Logger} from "../utils/logger";
import {CachingStrategy} from "../utils/caching-strategy";
import {IndexedStore} from "../utils/indexed-store";
import {FileCacheFetch} from "../utils/file-cache-fetch";
import {createMeasuredFetch, getHttpMetricsSnapshot} from "../utils/http-metrics";

const queryMessageLocations = `PREFIX ldp: <http://www.w3.org/ns/ldp#>
SELECT ?messageLocations WHERE {
    ?folder ldp:contains ?messageLocations .
}`;

const queryMessageBoxes = `PREFIX schema: <http://schema.org/>
SELECT ?roomUrl ?messageBox ?endDate WHERE {
  ?messageBox a schema:CreativeWorkSeries .
  ?messageBox schema:about ?roomUrl.
  OPTIONAL {
    ?messageBox schema:endDate ?endDate .
  }
}`;

const queryRooms = `PREFIX schema: <http://schema.org/>
SELECT ?name ?members ?organizer ?startDate ?endDate ?thumbnailUrl WHERE {
  ?room a schema:EventSeries .
  ?room schema:name ?name .
  ?room schema:attendee ?members .
  ?room schema:organizer ?organizer .
  ?room schema:startDate ?startDate .
  OPTIONAL { ?room schema:image ?thumbnailUrl . }
  OPTIONAL { ?room schema:endDate ?endDate . }
}`;

const prefixes = `
@prefix trans: <http://localhost:5000/config/transformations#> .
@prefix fno: <https://w3id.org/function/ontology#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
`;

const fnoConfMessageLocations = `${prefixes}
_:MessageLocationsQuery
    a fno:Execution ;
    fno:executes trans:SPARQLEvaluation ;
    trans:queryString """${queryMessageLocations}"""^^xsd:string ;
    trans:sources ( "$MessageContainer$"^^xsd:string ) .
`;

const fnoConfMessageBoxes = `${prefixes}
_:MessageLocationsResultsSource
    a trans:SPARQLQueryResultSource ;
    trans:sparqlQueryResult <$MessageLocationsQueryResultLocation$> ;
    trans:extractVariables ( "messageLocations" ) .

_:MessageBoxesQuery
    a fno:Execution ;
    fno:executes trans:SPARQLEvaluation ;
    trans:queryString """${queryMessageBoxes}"""^^xsd:string ;
    trans:sources ( _:MessageLocationsResultsSource ) ;
    trans:discoverySources ( "$MessageContainer$"^^xsd:string ) .
`;

const fnoConfRooms = `${prefixes}
_:MessageBoxesResultsSource
    a trans:SPARQLQueryResultSource ;
    trans:sparqlQueryResult <$MessageBoxesQueryResultLocation$> ;
    trans:extractVariables ( "roomUrl" ) .

_:RoomsQuery
    a fno:Execution ;
    fno:executes trans:SPARQLEvaluation ;
    trans:queryString """${queryRooms}"""^^xsd:string ;
    trans:sources ( _:MessageBoxesResultsSource ) ;
    trans:discoverySources ( "$MessageContainer$"^^xsd:string ) .
`;

async function runQueriesInWorker(
  podContext: PodContext,
  cache: CachingStrategy,
  authorizationMode = "nondelegated"
): Promise<ExperimentResult> {
  const auth = authorizationMode === "no-auth" ? undefined : new Auth(podContext, {enableCache: false});
  await auth?.init();
  await auth?.getAccessToken();
  const engine = new QueryEngine();
  const resourceFetch = auth ? auth.fetch.bind(auth) : createMeasuredFetch();
  const queryFetch = cache === "file-cache"
    ? new FileCacheFetch(resourceFetch).fetch
    : resourceFetch;

  if (cache === "indexed-cache") {
    const store = new IndexedStore();
    await store.add([`${podContext.baseUrl}/watchparties/myMessages/`], resourceFetch);

    const messageLocations = await (await engine.queryBindings(queryMessageLocations, {
      sources: [ store.store ],
    }))
      .map((bindings) => bindings.get('messageLocations')!.value)
      .toArray()
    await store.add(messageLocations, resourceFetch);

    const roomLocations = await (await engine.queryBindings(queryMessageBoxes, {
      sources: [ store.store ],
    }))
      .map((bindings) => bindings.get('roomUrl')!.value)
      .toArray()
    await store.add(roomLocations, resourceFetch);

    const setupHttpMetrics = await getHttpMetricsSnapshot();
    const startTime = ExperimentResult.startMeasurement();
    await (await engine.queryBindings(queryMessageLocations, {
      sources: [ store.store ],
    }))
      .toArray()
    await (await engine.queryBindings(queryMessageBoxes, {
      sources: [ store.store ],
    }))
      .toArray()
    const resultIterator: AsyncIterator<any> = await engine.queryBindings(queryRooms, {
      sources: [ store.store ],
    });

    return await ExperimentResult.fromIterator(
      podContext.name + "_" + cache,
      startTime,
      resultIterator,
      { setupHttpMetrics, numberOfTriples: store.store.getQuads(null, null, null, null).length }
    );
  }

  if (cache === "file-cache") {
    const messageLocations = await (await engine.queryBindings(queryMessageLocations, {
      sources: [`${podContext.baseUrl}/watchparties/myMessages/`],
      fetch: queryFetch
    }))
      .map((bindings) => bindings.get('messageLocations')!.value)
      .toArray();

    const roomLocations = new Set<string>();
    for (const messageLocation of messageLocations) {
      const rooms = await (await engine.queryBindings(queryMessageBoxes, {
        sources: [messageLocation],
        fetch: queryFetch
      }))
        .map((bindings) => bindings.get('roomUrl')!.value)
        .toArray();
      rooms.forEach(room => roomLocations.add(room));
    }

    await Promise.all([ ...roomLocations ].map(room =>
      queryFetch(room, { headers: { Accept: "text/turtle" } })
    ));
  }

  const setupHttpMetrics = await getHttpMetricsSnapshot();
  const startTime = ExperimentResult.startMeasurement();

  const messageLocationsBindingsStream = await engine.queryBindings(queryMessageLocations, {
    sources: [`${podContext.baseUrl}/watchparties/myMessages/`],
    fetch: queryFetch
  });

  let resultIterator: any;

  resultIterator = new UnionIterator<any>(new UnionIterator<any>(messageLocationsBindingsStream.transform({
    transform: async (bindings, done: () => void, push: (bindingsStream: any) => void) => {
      push(await engine.queryBindings(queryMessageBoxes, {
        sources: [bindings.get('messageLocations')!.value],
        fetch: queryFetch
      }));
      done();
    },
  })).transform({
    transform: async (bindings, done, push) => {
      const room = bindings.get('roomUrl')!.value;
      push(await engine.queryBindings(
        queryRooms,
        {
          sources: [room],
          fetch: queryFetch
        }
      ));
      done();
    },
  }));

  return await ExperimentResult.fromIterator(
    podContext.name + "_" + cache,
    startTime,
    resultIterator,
    { setupHttpMetrics }
  );
}

export class OverviewPageExperiment extends WatchpartyDataGenerator implements Experiment {
  async runLocal(iterations: number): Promise<ExperimentResult[]> {
    const results: ExperimentResult[] = [];

    for (let iteration = 0; iteration < iterations; iteration++) {
      for (const iterationConfig of this.experimentConfig.iterations) {
        for (const arg of iterationConfig.args) {
          const podName = iterationConfig.iterationName + "-" + arg.join("_") + "_query-user";
          const podContext = this.getPodContextByName(podName);
          for (const cache of ["no-cache", "file-cache", "indexed-cache"]) {
            Logger.info(`Running local experiment for pod ${podName}, cache ${cache}, iteration ${iteration + 1}/${iterations}`);
            await new Promise<ExperimentResult>((resolve, reject) => {
              const logLevel = Logger.getLevel()
              const worker = new Worker(__filename, {
                workerData: {logLevel, podContext, cache, authorizationMode: this.experimentConfig.authorizationMode}
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
                console.error(`Worker error for ${podContext.name}:`, error);
                reject(error);
              });

              worker.on('exit', (code) => {
                if (code !== 0) {
                  //console.error(`Worker stopped with exit code ${code}`);
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
          const podName = iterationConfig.iterationName + "-" + arg.join("_") + "_query-user";
          const podContext = this.getPodContextByName(podName);
          const messageContainer = `${podContext.baseUrl}/watchparties/myMessages/`;
          const expectedResults = arg[0] * 2;

          for (const cache of ["no-cache"]) {
            Logger.info(`Running ${discover ? "discovered aggregator" : "aggregator"} experiment for pod ${podName}, iteration ${iteration + 1}/${iterations}`);
            await this.setupAggregator(podContext, messageContainer, arg[0], expectedResults);

            const auth = this.experimentConfig.authorizationMode === "no-auth"
              ? undefined
              : new Auth(podContext, {enableCache: false});
            await auth?.init();
            await auth?.getAccessToken();
            const serviceFetch = auth ? auth.fetch.bind(auth) : createMeasuredFetch();

            const setupHttpMetrics = await getHttpMetricsSnapshot();
            const startTime = ExperimentResult.startMeasurement();

            const aggregatorResult = await ExperimentResult.fromJson(
              podContext.name + (discover ? "_aggregator_discovered" : "_aggregator"),
              startTime,
              discover
                ? await getDiscoveredAggregatorService(serviceFetch, [ messageContainer ], queryRooms)
                : await getAggregatorService(serviceFetch, this.aggregatorIdStore.get(podContext.name)!),
              { setupHttpMetrics }
            );
            results.push(aggregatorResult);

            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
      }
    }
    return results;
  }

  private async setupAggregator(
    podContext: PodContext,
    messageContainer: string,
    expectedMessageLocations: number,
    expectedRoomBindings: number
  ) {
    if (this.aggregatorIdStore.has(podContext.name)) {
      return;
    }
    const auth = new Auth(podContext, {enableCache: true});
    await auth.init();
    await auth.getAccessToken();

    // start first aggregator with message locations query
    const messageLocationsId = await createAggregatorService(auth, fnoConfMessageLocations.replace(
      "$MessageContainer$",
      messageContainer
    ));
    await waitForAggregatorService(auth, messageLocationsId, expectedMessageLocations);

    // start second aggregator with message boxes query passing in the result of the first
    const messageBoxesId = await createAggregatorService(auth, fnoConfMessageBoxes.replace(
      "$MessageLocationsQueryResultLocation$",
      `http://localhost:5000/${messageLocationsId}/`
    ).replace(
      "$MessageContainer$",
      messageContainer
    ));
    await waitForAggregatorService(auth, messageBoxesId, expectedMessageLocations);

    // start third aggregator with rooms query passing in the result of the second
    const roomsId = await createAggregatorService(auth, fnoConfRooms.replace(
      "$MessageBoxesQueryResultLocation$",
      `http://localhost:5000/${messageBoxesId}/`
    ).replace(
      "$MessageContainer$",
      messageContainer
    ))
    this.aggregatorIdStore.set(podContext.name, roomsId);
    await waitForAggregatorService(auth, roomsId, expectedRoomBindings);
  }

  generate(): ExperimentSetup {
    this.removeGeneratedData();
    for (const iteration of this.experimentConfig.iterations) {
      for (const arg of iteration.args) {
        this.generateForOverviewPage(iteration.iterationName+"-"+arg.join("_"), arg[0]);
      }
    }
    const firstIteration = this.experimentConfig.iterations[0];
    const firstArg = firstIteration.args[0];
    const firstExperimentId = `${firstIteration.iterationName}-${firstArg.join("_")}`;
    const queryUserContext = this.getUserPodContext(this.queryUser, firstExperimentId);
    return this.finalizeGeneration(queryUserContext);
  }

  private generateForOverviewPage(experimentId: string, numberOfJoinedWatchparties: number) {
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

    for (let i = 1; i <= numberOfJoinedWatchparties; i++) {
      const randomDate = new Date(Date.now() + Math.floor(Math.random() * 10000000000));
      const isoDate = randomDate.toISOString();
      const userId = `user${i}`;
      const userContext = this.getUserPodContext(userId, experimentId);
      const userPodUrl = userContext.baseUrl;
      const userRelativePath = userContext.relativePath;
      const roomId = `room-of-user${i}`;
      const roomTriples = `<#${roomId}> a <http://schema.org/EventSeries>;
    <http://schema.org/description> "Solid Watchparty";
    <http://schema.org/name> "Room of user${i}";
    <http://schema.org/organizer> <${userPodUrl}/profile/card#me>;
    <http://schema.org/startDate> "${isoDate}"^^<http://www.w3.org/2001/XMLSchema#dateTime>;
    <http://schema.org/attendee> <${userPodUrl}/profile/card#me>, <${queryUserPodUrl}/profile/card#me>;
    <http://schema.org/subjectOf> <${userPodUrl}/watchparties/myMessages/${roomId}#outbox>.
`;
      const roomFilePath = `${this.outputDirectory}/${userRelativePath}/watchparties/myRooms/${roomId}/room$.ttl`;
      fs.mkdirSync(path.dirname(roomFilePath), { recursive: true });
      fs.writeFileSync(roomFilePath, roomTriples);

      const queryableUserMessagesTriples = `<#outbox> a <http://schema.org/CreativeWorkSeries>;
    <http://schema.org/about> <${userPodUrl}/watchparties/myRooms/${roomId}/room#${roomId}>;
    <http://schema.org/creator> <${queryUserPodUrl}/profile/card#me>.
            `
      const queryableUserMessagesFilePath = `${this.outputDirectory}/${queryUserRelativePath}/watchparties/myMessages/${roomId}$.ttl`;
      fs.mkdirSync(path.dirname(queryableUserMessagesFilePath), { recursive: true });
      fs.writeFileSync(queryableUserMessagesFilePath, queryableUserMessagesTriples);
    }
  }
}

// Worker thread execution - runs when this file is loaded as a worker
if (!isMainThread && parentPort) {
  Logger.setLevel(workerData.logLevel);
  runQueriesInWorker(workerData.podContext, workerData.cache, workerData.authorizationMode)
    .then(result => {
      parentPort!.postMessage({ success: true, result: result.serialize() });
    })
    .catch(error => {
      parentPort!.postMessage({ success: false, error: error.message });
    });
}
