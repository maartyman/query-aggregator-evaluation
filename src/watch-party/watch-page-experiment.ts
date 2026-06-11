import {WatchpartyDataGenerator} from "./generate-data-watchparty";
import * as fs from "node:fs";
import path from "node:path";
import {Auth} from "../utils/auth";
import {QueryEngine} from "@comunica/query-sparql";
import {isMainThread, parentPort, Worker, workerData} from 'worker_threads';
import {UnionIterator} from "asynciterator";
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

const queryRoom = `PREFIX schema: <http://schema.org/>
SELECT ?messageBoxUrl
WHERE {
  ?eventSeries a schema:EventSeries .
  ?eventSeries schema:subjectOf ?messageBoxUrl .
}`;

const queryMessages = `PREFIX schema: <http://schema.org/>
SELECT ?message ?dateSent ?text ?creator
WHERE {
    $messageBoxUrl$ schema:hasPart ?message ;
     schema:creator ?creator .
    ?message a schema:Message .
    ?message schema:dateSent ?dateSent .
    ?message schema:text ?text .
}`

const queryPerson = `PREFIX foaf: <http://xmlns.com/foaf/0.1/>
SELECT ?name
WHERE {
    ?creator foaf:name ?name .
}`;

const prefixes = `
@prefix trans: <http://localhost:5000/config/transformations#> .
@prefix fno: <https://w3id.org/function/ontology#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
`;

const fnoConfRoom = `${prefixes}
_:MessageLocationsQuery
    a fno:Execution ;
    fno:executes trans:SPARQLEvaluation ;
    trans:queryString """${queryRoom}"""^^xsd:string ;
    trans:sources ( "$room$"^^xsd:string ) .
`;

const fnoConfMessages = `${prefixes}
_:MessageLocationsResultsSource
    a trans:SPARQLQueryResultSource ;
    trans:sparqlQueryResult <$MessageLocationsQueryResultLocation$> ;
    trans:extractVariables ( "messageBoxUrl" ) .

_:MessageBoxesQuery
    a fno:Execution ;
    fno:executes trans:SPARQLEvaluation ;
    trans:queryString """${queryMessages}"""^^xsd:string ;
    trans:sources ( _:MessageLocationsResultsSource ) ;
    trans:discoverySources ( "$room$"^^xsd:string ) .
`;

const fnoConfPerson = `${prefixes}
_:MessageBoxesResultsSource
    a trans:SPARQLQueryResultSource ;
    trans:sparqlQueryResult <$MessageBoxes$> ;
    trans:extractVariables ( "creator" ) .

_:RoomsQuery
    a fno:Execution ;
    fno:executes trans:SPARQLEvaluation ;
    trans:queryString """${queryPerson}"""^^xsd:string ;
    trans:sources ( _:MessageBoxesResultsSource ) ;
    trans:discoverySources ( "$room$"^^xsd:string ) .
`;

async function runQueriesInWorker(podContext: PodContext, room: string, cache: CachingStrategy, authorizationMode = "nondelegated"): Promise<ExperimentResult> {
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
    const roomIri = `${podContext.baseUrl}/watchparties/myRooms/${room}/room#${room}`;
    await store.add([roomIri], resourceFetch);

    const messageBoxLocations = await (await engine.queryBindings(queryRoom, {
      sources: [ store.store ],
    })).map((bindings) => bindings.get('messageBoxUrl')!.value).toArray()
    await store.add(messageBoxLocations, resourceFetch);

    const creatorLocations = await (await engine.queryBindings(queryMessages.replace(/\$messageBoxUrl\$/g, `?messageBox`), {
      sources: [ store.store ],
    })).map((bindings) => bindings.get('creator')!.value).toArray()
    await store.add(creatorLocations, resourceFetch);

    const setupHttpMetrics = await getHttpMetricsSnapshot();
    const startTime = ExperimentResult.startMeasurement();
    await (await engine.queryBindings(queryRoom, {
      sources: [ store.store ],
    }))
      .toArray();
    await (await engine.queryBindings(queryMessages.replace(/\$messageBoxUrl\$/g, `?messageBox`), {
      sources: [ store.store ],
    }))
      .toArray();
    const resultIterator = await engine.queryBindings(queryPerson, {
      sources: [ store.store ],
    })

    return await ExperimentResult.fromIterator(
      podContext.name + "_" + cache,
      startTime,
      resultIterator,
      { setupHttpMetrics, numberOfTriples: store.store.getQuads(null, null, null, null).length }
    );
  }

  if (cache === "file-cache") {
    const roomIri = `${podContext.baseUrl}/watchparties/myRooms/${room}/room#${room}`;
    const messageBoxLocations = await (await engine.queryBindings(queryRoom, {
      sources: [roomIri],
      fetch: queryFetch
    }))
      .map((bindings) => bindings.get('messageBoxUrl')!.value)
      .toArray();

    const creatorLocations = new Set<string>();
    for (const messageBoxLocation of messageBoxLocations) {
      const creators = await (await engine.queryBindings(
        queryMessages.replace(/\$messageBoxUrl\$/g, `<${messageBoxLocation}>`),
        {
          sources: [messageBoxLocation],
          fetch: queryFetch
        }
      ))
        .map((bindings) => bindings.get('creator')!.value)
        .toArray();
      creators.forEach(creator => creatorLocations.add(creator));
    }

    await Promise.all([ ...creatorLocations ].map(creator =>
      queryFetch(creator, { headers: { Accept: "text/turtle" } })
    ));
  }

  const setupHttpMetrics = await getHttpMetricsSnapshot();
  const startTime = ExperimentResult.startMeasurement();

  const roomIri = `${podContext.baseUrl}/watchparties/myRooms/${room}/room#${room}`;
  const roomBindingsStream = await engine.queryBindings(queryRoom, {
    sources: [roomIri],
    fetch: queryFetch
  });

  const creators = new Set();
  let resultIterator;
  resultIterator = new UnionIterator<any>(new UnionIterator<any>(roomBindingsStream.transform({
      transform: async (bindings, done: () => void, push: (bindingsStream: any) => void) => {
        let messageboxUrl = bindings.get('messageBoxUrl')!.value;
        push(await engine.queryBindings(
          queryMessages.replace(/\$messageBoxUrl\$/g, `<${messageboxUrl}>`),
          {
            sources: [messageboxUrl],
            fetch: queryFetch
          }));
        done();
      },
    }))
      .transform({
        transform: async (bindings, done: () => void, push: (bindingsStream: any) => void) => {
          const creator = bindings.get('creator')!.value;
          if (creators.has(creator)) {
            return done();
          }
          creators.add(creator);
          push(await engine.queryBindings(
            queryPerson,
            {
              sources: [creator],
              fetch: queryFetch
            }
          ));
          done();
        },
      })
  );

  return await ExperimentResult.fromIterator(
    podContext.name + "_" + cache,
    startTime,
    resultIterator,
    { setupHttpMetrics }
  );
}

export class WatchPageExperiment extends WatchpartyDataGenerator implements Experiment {
  generate(): ExperimentSetup {
    this.removeGeneratedData();
    for (const iteration of this.experimentConfig.iterations) {
      for (const arg of iteration.args) {
        this.generateForWatchPage(iteration.iterationName+"-"+arg.join("_"), arg[0], arg[1]);
      }
    }
    const firstIteration = this.experimentConfig.iterations[0];
    const firstArg = firstIteration.args[0];
    const firstExperimentId = `${firstIteration.iterationName}-${firstArg.join("_")}`;
    const queryUserContext = this.getUserPodContext(this.queryUser, firstExperimentId);
    return this.finalizeGeneration(queryUserContext);
  }

  async runLocal(iterations: number): Promise<ExperimentResult[]> {
    const results: ExperimentResult[] = [];

    for (let iteration = 0; iteration < iterations; iteration++) {
      for (const iterationConfig of this.experimentConfig.iterations) {
        for (const arg of iterationConfig.args) {
          const podName = iterationConfig.iterationName + "-" + arg.join("_") + "_query-user";
          const podContext = this.getPodContextByName(podName);
          for (const cache of ["no-cache", "file-cache", "indexed-cache"]) {
            Logger.info(`Running local experiment for pod ${podName}, cache ${cache}, iteration ${iteration + 1}/${iterations}`);
            const result = await new Promise<ExperimentResult>((resolve, reject) => {
              const logLevel = Logger.getLevel()
              const worker = new Worker(__filename, {
                workerData: {logLevel, podContext, roomName: this.room, cache, authorizationMode: this.experimentConfig.authorizationMode}
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
          const roomSource = `${podContext.baseUrl}/watchparties/myRooms/${this.room}/room#${this.room}`;
          const expectedMembers = arg[0];
          const expectedMessages = arg[0] * arg[1];

          for (const cache of ["no-cache"]) {
            Logger.info(`Running ${discover ? "discovered aggregator" : "aggregator"} experiment for pod ${podName}, iteration ${iteration + 1}/${iterations}`);
            await this.setupAggregator(podContext, roomSource, expectedMembers, expectedMessages);

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
                ? await getDiscoveredAggregatorService(serviceFetch, [ roomSource ], queryPerson)
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
    roomSource: string,
    expectedMembers: number,
    expectedMessages: number
  ) {
    if (this.aggregatorIdStore.has(podContext.name)) {
      return;
    }
    const auth = new Auth(podContext, {enableCache: true});
    await auth.init();
    await auth.getAccessToken();

    const roomInfoId = await createAggregatorService(auth, fnoConfRoom.replace(
      "$room$",
      roomSource
    ));
    await waitForAggregatorService(auth, roomInfoId);

    const messageBoxesId = await createAggregatorService(auth, fnoConfMessages.replace(
      "$MessageLocationsQueryResultLocation$",
      `http://localhost:5000/${roomInfoId}/`
    ).replace(
      "$messageBoxUrl$",
      "?messageBox"
    ).replace(
      "$room$",
      roomSource
    ));
    await waitForAggregatorService(auth, messageBoxesId, expectedMessages);

    const personId = await createAggregatorService(auth, fnoConfPerson.replace(
      "$MessageBoxes$",
      `http://localhost:5000/${messageBoxesId}/`
    ).replace(
      "$room$",
      roomSource
    ))
    this.aggregatorIdStore.set(podContext.name, personId);
    await waitForAggregatorService(auth, personId, expectedMembers);
  }

  public generateForWatchPage(experimentId: string, numberOfMembers: number, numberOfMessagesPerMember: number) {
    const randomDate = new Date(Date.now() + Math.floor(Math.random() * 10000000000));
    const isoDate = randomDate.toISOString();
    const queryUserContext = this.getUserPodContext(this.queryUser, experimentId);
    const queryUserPodUrl = queryUserContext.baseUrl;
    const queryUserRelativePath = queryUserContext.relativePath;

    const organizerUserId = numberOfMembers > 0 ? 'user1' : this.queryUser;
    const organizerContext = this.getUserPodContext(organizerUserId, experimentId);
    const organizerPodUrl = organizerContext.baseUrl;

    let roomTriples = `<#${this.room}> a <http://schema.org/EventSeries>;
    <http://schema.org/description> "Solid Watchparty";
    <http://schema.org/name> "Room of ${this.queryUser}";
    <http://schema.org/organizer> <${organizerPodUrl}/profile/card#me>;
    <http://schema.org/startDate> "${isoDate}"^^<http://www.w3.org/2001/XMLSchema#dateTime>;
    <http://schema.org/attendee>`;
    for (let i = 1; i <= numberOfMembers; i++) {
      const userId = `user${i}`;
      const userContext = this.getUserPodContext(userId, experimentId);
      roomTriples += `
        <${userContext.baseUrl}/profile/card#me>`;
      if (i < numberOfMembers) {
        roomTriples += `,`;
      } else {
        roomTriples += `;`;
      }
    }
    roomTriples += `
    <http://schema.org/subjectOf>`;
    for (let i = 1; i <= numberOfMembers; i++) {
      const userId = `user${i}`;
      const userContext = this.getUserPodContext(userId, experimentId);
      roomTriples += `
        <${userContext.baseUrl}/watchparties/myMessages/${this.room}#outbox>`;
      if (i < numberOfMembers) {
        roomTriples += `,`;
      } else {
        roomTriples += `.`;
      }
    }
    const roomFilePath = `${this.outputDirectory}/${queryUserRelativePath}/watchparties/myRooms/${this.room}/room$.ttl`;
    fs.mkdirSync(path.dirname(roomFilePath), {recursive: true});
    fs.writeFileSync(roomFilePath, roomTriples);

    const queryUserCardTriples = `@prefix foaf: <http://xmlns.com/foaf/0.1/>.
@prefix solid: <http://www.w3.org/ns/solid/terms#>.

<>
    a foaf:PersonalProfileDocument;
    foaf:maker <${queryUserPodUrl}/profile/card#me>;
    foaf:primaryTopic <${queryUserPodUrl}/profile/card#me>.

<${queryUserPodUrl}/profile/card#me>
    solid:oidcIssuer <${queryUserContext.server.solidBaseUrl}>;
    a foaf:Person;
    foaf:name "Query User" .
`;
    const queryUserCardFilePath = `${this.outputDirectory}/${queryUserRelativePath}/profile/card$.ttl`;
    fs.mkdirSync(path.dirname(queryUserCardFilePath), {recursive: true});
    fs.writeFileSync(queryUserCardFilePath, queryUserCardTriples);

    for (let i = 1; i <= numberOfMembers; i++) {
      const userId = `user${i}`;
      const userContext = this.getUserPodContext(userId, experimentId);
      const userPodUrl = userContext.baseUrl;
      const userRelativePath = userContext.relativePath;
      const cardTriples = `@prefix foaf: <http://xmlns.com/foaf/0.1/>.
@prefix solid: <http://www.w3.org/ns/solid/terms#>.

<>
    a foaf:PersonalProfileDocument;
    foaf:maker <${userPodUrl}/profile/card#me>;
    foaf:primaryTopic <${userPodUrl}/profile/card#me>.

<${userPodUrl}/profile/card#me>
    solid:oidcIssuer <${userContext.server.solidBaseUrl}>;
    a foaf:Person;
    foaf:name "User ${i}" .
`;
      const cardFilePath = `${this.outputDirectory}/${userRelativePath}/profile/card$.ttl`;
      fs.mkdirSync(path.dirname(cardFilePath), {recursive: true});
      fs.writeFileSync(cardFilePath, cardTriples);

      let messageBoxTriples = `<#outbox> a <http://schema.org/CreativeWorkSeries>;
    <http://schema.org/about> <${queryUserPodUrl}/watchparties/myRooms/${this.room}/room#${this.room}>;
    <http://schema.org/creator> <${userPodUrl}/profile/card#me>;
    <http://schema.org/hasPart>`;
      for (let j = 1; j <= numberOfMessagesPerMember; j++) {
        messageBoxTriples += `
        <#message-of-user${i}-${j}>`;
        if (j < numberOfMessagesPerMember) {
          messageBoxTriples += `,`;
        } else {
          messageBoxTriples += `.`;
        }
      }
      for (let j = 1; j <= numberOfMessagesPerMember; j++) {
        const messageDate = new Date(Date.now() + Math.floor(Math.random() * 10000000000));
        const messageIsoDate = messageDate.toISOString();
        messageBoxTriples += `
<#message-of-user${i}-${j}> a <http://schema.org/Message>;
    <http://schema.org/sender> <${userPodUrl}/profile/card#me>;
    <http://schema.org/isPartOf> <#outbox>;
    <http://schema.org/dateSent> "${messageIsoDate}"^^<http://www.w3.org/2001/XMLSchema#dateTime>;
    <http://schema.org/text> "Message ${j} of user${i}".`;
      }
      const messageBoxFilePath = `${this.outputDirectory}/${userRelativePath}/watchparties/myMessages/${this.room}$.ttl`;
      fs.mkdirSync(path.dirname(messageBoxFilePath), {recursive: true});
      fs.writeFileSync(messageBoxFilePath, messageBoxTriples);
    }
  }
}

// Worker thread execution - runs when this file is loaded as a worker
if (!isMainThread && parentPort) {
  Logger.setLevel(workerData.logLevel);
  runQueriesInWorker(workerData.podContext, workerData.roomName, workerData.cache, workerData.authorizationMode)
    .then(result => {
      parentPort!.postMessage({ success: true, result: result.serialize() });
    })
    .catch(error => {
      parentPort!.postMessage({ success: false, error: error.message });
    });
}

/*
source: a given roomIri
source: ?roomIri
PREFIX schema: <${SCHEMA_ORG}>
SELECT ?creator
WHERE {
    <${roomIri}> schema:subjectOf ?messageBoxUrl .
}

source: ?messageBoxUrl
PREFIX schema: <${SCHEMA_ORG}>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
SELECT ?message ?dateSent ?text ?sender
WHERE {
    <${messageBoxUrl}> schema:hasPart ?message .
    ?message a schema:Message .
    ?message schema:dateSent ?dateSent .
    ?message schema:text ?text .
    ?message schema:sender ?sender .
}

source: ?sender
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
SELECT ?name
WHERE {
    <${sender}> foaf:name ?name .
}
  */
