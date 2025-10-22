import {LinkTraversalMethod, WatchpartyDataGenerator} from "./generate-data-watchparty";
import * as fs from "node:fs";
import path from "node:path";
import {isMainThread, parentPort, Worker, workerData} from 'worker_threads';
import {Auth} from '../utils/auth';
import {QueryEngine} from '@comunica/query-sparql';
import {UnionIterator} from "asynciterator";
import {ExperimentResult} from "../utils/result-builder";

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
    trans:sources ( _:MessageLocationsResultsSource ) .
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
    trans:sources ( _:MessageBoxesResultsSource ) .
`;

async function runQueriesInWorker(podName: string, linkTraversalMethod: LinkTraversalMethod): Promise<ExperimentResult> {
  const auth = new Auth(podName);
  await auth.init();
  await auth.getAccessToken();
  const engine = new QueryEngine();

  const startTime = process.hrtime();

  const messageLocationsBindingsStream = await engine.queryBindings(queryMessageLocations, {
    sources: [`http://localhost:3000/${podName}/watchparties/myMessages/`],
    fetch: auth.fetch.bind(auth)
  });

  let resultIterator: any;
  if (linkTraversalMethod === LinkTraversalMethod.BreadthFirst) {
    resultIterator = new UnionIterator<any>(new UnionIterator<any>(messageLocationsBindingsStream.map(
      (bindings) => {
        return engine.queryBindings(queryMessageBoxes, {
          sources: [bindings.get('messageLocations')!.value],
          fetch: auth.fetch.bind(auth)
        });
      }
    )).map(
      (bindings) => {
        const room = bindings.get('roomUrl')!.value;
        return engine.queryBindings(
          queryRooms,
          {
            sources: [room],
            fetch: auth.fetch.bind(auth)
          }
        );
      },
    ));
  } else {
    resultIterator = new UnionIterator<any>(new UnionIterator<any>(messageLocationsBindingsStream.transform({
      transform: async (bindings, done: () => void, push: (bindingsStream: any) => void) => {
        push(await engine.queryBindings(queryMessageBoxes, {
          sources: [bindings.get('messageLocations')!.value],
          fetch: auth.fetch.bind(auth)
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
            fetch: auth.fetch.bind(auth)
          }
        ));
        done();
      },
    }));
  }

  return await ExperimentResult.fromIterator(
    podName+"_"+linkTraversalMethod,
    startTime,
    resultIterator
  );
}

export class OverviewPageExperiment extends WatchpartyDataGenerator implements Experiment {
  generate(): string {
    for (const iteration of this.experimentConfig.iterations) {
      for (const arg of iteration.args) {
        this.generateForOverviewPage(iteration.iterationName+"-"+arg.join("_"), arg[0]);
      }
    }
    this.generateMetaData();
    return this.getUserPodRelativePath(
      this.queryUser,
      this.experimentConfig.iterations[0].iterationName+"-"+this.experimentConfig.iterations[0].args[0].join("_")
    );
  }

  async setupAggregators() {
    const promises: Promise<void>[] = [];
    for (const iteration of this.experimentConfig.iterations) {
      for (const arg of iteration.args) {
        promises.push(this.setupAggregator(iteration.iterationName + "-" + arg.join("_") + "_query-user"));
      }
    }
    await Promise.all(promises);
  }

  async run(saveResults: boolean, iterations: number): Promise<void> {
    const results: ExperimentResult[] = [];

    for (let iteration = 0; iteration < iterations; iteration++) {
      for (const iterationConfig of this.experimentConfig.iterations) {
        for (const arg of iterationConfig.args) {
          const podName = iterationConfig.iterationName + "-" + arg.join("_") + "_query-user";
          for (const linkTraversalMethod of [LinkTraversalMethod.DepthFirst, LinkTraversalMethod.BreadthFirst]) {
            const result = await new Promise<ExperimentResult>((resolve, reject) => {
              const worker = new Worker(__filename, {
                workerData: {podName, linkTraversalMethod}
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
                  //console.error(`Worker failed for ${podName}:`, message.error);
                  reject(new Error(message.error));
                }
                worker.terminate();
              });

              worker.on('error', (error) => {
                console.error(`Worker error for ${podName}:`, error);
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

          const auth = new Auth(podName);
          await auth.init();
          await auth.getAccessToken();

          const startTime = process.hrtime();

          const aggregatorReult = ExperimentResult.fromJson(
            podName + "_aggregator",
            startTime,
            await this.getAggregatorService(auth, this.aggregatorIdStore.get(podName)!)
          );
          results.push(aggregatorReult);
          if (saveResults) {
            aggregatorReult.print();
          }

          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    }
  }

  private async setupAggregator(podName: string) {
    const auth = new Auth(podName);
    await auth.init();
    await auth.getAccessToken();

    // start first aggregator with message locations query
    const messageLocationsId = await this.createAggregatorService(auth, fnoConfMessageLocations.replace(
      "$MessageContainer$",
      `http://localhost:3000/${podName}/watchparties/myMessages/`
    ));
    await this.waitForAggregatorService(auth, messageLocationsId);

    // start second aggregator with message boxes query passing in the result of the first
    const messageBoxesId = await this.createAggregatorService(auth, fnoConfMessageBoxes.replace(
      "$MessageLocationsQueryResultLocation$",
      `http://localhost:5000/${messageLocationsId}/`
    ));
    await this.waitForAggregatorService(auth, messageBoxesId);

    // start third aggregator with rooms query passing in the result of the second
    this.aggregatorIdStore.set(podName, await this.createAggregatorService(auth, fnoConfRooms.replace(
      "$MessageBoxesQueryResultLocation$",
      `http://localhost:5000/${messageBoxesId}/`
    )));
    await this.waitForAggregatorService(auth, messageBoxesId);
  }

  private generateForOverviewPage(experimentId: string, numberOfJoinedWatchparties: number) {
    const queryUserPodUrl = this.getUserPodUrl(this.queryUser, experimentId);
    const queryUserRelativePath = this.getUserPodRelativePath(this.queryUser, experimentId);
    const cardTriples = `@prefix foaf: <http://xmlns.com/foaf/0.1/>.
@prefix solid: <http://www.w3.org/ns/solid/terms#>.

<>
    a foaf:PersonalProfileDocument;
    foaf:maker <${queryUserPodUrl}/profile/card#me>;
    foaf:primaryTopic <${queryUserPodUrl}/profile/card#me>.

<${queryUserPodUrl}/profile/card#me>
    solid:oidcIssuer <${this.podProviderUrl}>;
    a foaf:Person.
`;
    const cardFilePath = `${this.outputDirectory}/${queryUserRelativePath}/profile/card$.ttl`;
    fs.mkdirSync(path.dirname(cardFilePath), { recursive: true });
    fs.writeFileSync(cardFilePath, cardTriples);

    for (let i = 1; i <= numberOfJoinedWatchparties; i++) {
      const randomDate = new Date(Date.now() + Math.floor(Math.random() * 10000000000));
      const isoDate = randomDate.toISOString();
      const userId = `user${i}`;
      const userPodUrl = this.getUserPodUrl(userId, experimentId);
      const userRelativePath = this.getUserPodRelativePath(userId, experimentId);
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
  runQueriesInWorker(workerData.podName, workerData.linkTraversalMethod)
    .then(result => {
      parentPort!.postMessage({ success: true, result: result.serialize() });
    })
    .catch(error => {
      parentPort!.postMessage({ success: false, error: error.message });
    });
}
