import {LinkTraversalMethod, WatchpartyDataGenerator} from "./generate-data-watchparty";
import * as fs from "node:fs";
import path from "node:path";
import {Auth} from "../auth";
import {QueryEngine} from "@comunica/query-sparql";
import {isMainThread, parentPort, Worker, workerData} from 'worker_threads';
import {UnionIterator} from "asynciterator";
import {ExperimentResult} from "../utils/result-builder";

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
    $creator$ foaf:name ?name .
}`;

async function runQueriesInWorker(podName: string, room: string, linkTraversalMethod: LinkTraversalMethod): Promise<ExperimentResult> {
  const auth = new Auth(podName);
  await auth.init();
  await auth.getAccessToken();
  const engine = new QueryEngine();

  const startTime = process.hrtime();
  const roomIri = `http://localhost:3000/${podName}/watchparties/myRooms/${room}/room#${room}`;
  const roomBindingsStream = await engine.queryBindings(queryRoom, {
    sources: [roomIri],
    fetch: auth.fetch.bind(auth)
  });

  const creators = new Set();
  let resultIterator;
  if (linkTraversalMethod === LinkTraversalMethod.BreadthFirst) {
    resultIterator = new UnionIterator<any>(new UnionIterator<any>(roomBindingsStream.transform({
      transform: async (bindings, done: () => void, push: (bindingsStream: any) => void) => {
        let messageboxUrl = bindings.get('messageBoxUrl')!.value;
        console.log(`Querying for message box ${messageboxUrl}`);
        push(engine.queryBindings(
          queryMessages.replace(/\$messageBoxUrl\$/g, `<${messageboxUrl}>`),
          {
            sources: [messageboxUrl],
            fetch: auth.fetch.bind(auth)
          }));
        done();
      },
    })).transform({
      transform: async (bindings, done: () => void, push: (bindingsStream: any) => void) => {
        const creator = bindings.get('creator')!.value;
        if (creators.has(creator)) {
          return done();
        }
        creators.add(creator);
        console.log(`Querying for creator ${creator}`);
        push(engine.queryBindings(
          queryPerson.replace(/\$creator\$/g, `<${creator}>`),
          {
            sources: [creator],
            fetch: auth.fetch.bind(auth)
          }
        ));
        done();
      },
    })
    );
  } else {
    resultIterator = new UnionIterator<any>(new UnionIterator<any>(roomBindingsStream.transform({
        transform: async (bindings, done: () => void, push: (bindingsStream: any) => void) => {
          let messageboxUrl = bindings.get('messageBoxUrl')!.value;
          push(await engine.queryBindings(
            queryMessages.replace(/\$messageBoxUrl\$/g, `<${messageboxUrl}>`),
            {
              sources: [messageboxUrl],
              fetch: auth.fetch.bind(auth)
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
              queryPerson.replace(/\$creator\$/g, `<${creator}>`),
              {
                sources: [creator],
                fetch: auth.fetch.bind(auth)
              }
            ));
            done();
          },
        })
    );
  }

  return await ExperimentResult.fromIterator(
    podName,
    startTime,
    resultIterator
  );
}

export class WatchPageExperiment extends WatchpartyDataGenerator implements Experiment {
  generate(): void {
    for (const iteration of this.experimentConfig.iterations) {
      for (const arg of iteration.args) {
        this.generateForWatchPage(iteration.iterationName+"-"+arg.join("_"), arg[0], arg[1]);
      }
    }
    this.generateMetaData();
  }

  async run(saveResults: boolean, iterations: number): Promise<void> {
    const results: ExperimentResult[] = [];

    for (let iteration = 0; iteration < iterations; iteration++) {
      for (const iterationConfig of this.experimentConfig.iterations) {
        for (const arg of iterationConfig.args) {
          for (const linkTraversalMethod of [LinkTraversalMethod.DepthFirst, LinkTraversalMethod.BreadthFirst]) {
            const podName = iterationConfig.iterationName + "-" + arg.join("_") + "_query-user";

            const result = await new Promise<ExperimentResult>((resolve, reject) => {
              const worker = new Worker(__filename, {
                workerData: {podName, roomName: this.room, linkTraversalMethod}
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
                  console.error(`Worker failed for ${podName}:`, message.error);
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
                  console.error(`Worker stopped with exit code ${code}`);
                }
              });
            });
          }
        }
      }
    }
  }

  public generateForWatchPage(experimentId: string, numberOfMembers: number, numberOfMessagesPerMember: number) {
    const randomDate = new Date(Date.now() + Math.floor(Math.random() * 10000000000));
    const isoDate = randomDate.toISOString();
    const queryUserPodUrl = this.getUserPodUrl(this.queryUser, experimentId);
    const queryUserRelativePath = this.getUserPodRelativePath(this.queryUser, experimentId);
    const organizerUserId = numberOfMembers > 0 ? 'user1' : this.queryUser;
    const organizerPodUrl = this.getUserPodUrl(organizerUserId, experimentId);
    let roomTriples = `<#${this.room}> a <http://schema.org/EventSeries>;
    <http://schema.org/description> "Solid Watchparty";
    <http://schema.org/name> "Room of ${this.queryUser}";
    <http://schema.org/organizer> <${organizerPodUrl}/profile/card#me>;
    <http://schema.org/startDate> "${isoDate}"^^<http://www.w3.org/2001/XMLSchema#dateTime>;
    <http://schema.org/attendee>`;
    for (let i = 1; i <= numberOfMembers; i++) {
      const userId = `user${i}`;
      const userPodUrl = this.getUserPodUrl(userId, experimentId);
      roomTriples += `
        <${userPodUrl}/profile/card#me>`;
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
      const userPodUrl = this.getUserPodUrl(userId, experimentId);
      roomTriples += `
        <${userPodUrl}/watchparties/myMessages/${this.room}#outbox>`;
      if (i < numberOfMembers) {
        roomTriples += `,`;
      } else {
        roomTriples += `.`;
      }
    }
    const roomFilePath = `${this.outputDirectory}/${queryUserRelativePath}/watchparties/myRooms/${this.room}/room$.ttl`;
    fs.mkdirSync(path.dirname(roomFilePath), { recursive: true });
    fs.writeFileSync(roomFilePath, roomTriples);

    // Generate profile card for the query user
    const queryUserCardTriples = `@prefix foaf: <http://xmlns.com/foaf/0.1/>.
@prefix solid: <http://www.w3.org/ns/solid/terms#>.

<>
    a foaf:PersonalProfileDocument;
    foaf:maker <${queryUserPodUrl}/profile/card#me>;
    foaf:primaryTopic <${queryUserPodUrl}/profile/card#me>.

<${queryUserPodUrl}/profile/card#me>
    solid:oidcIssuer <${this.podProviderUrl}>;
    a foaf:Person;
    foaf:name "Query User" .
`;
    const queryUserCardFilePath = `${this.outputDirectory}/${queryUserRelativePath}/profile/card$.ttl`;
    fs.mkdirSync(path.dirname(queryUserCardFilePath), { recursive: true });
    fs.writeFileSync(queryUserCardFilePath, queryUserCardTriples);

    for (let i = 1; i <= numberOfMembers; i++) {
      const userId = `user${i}`;
      const userPodUrl = this.getUserPodUrl(userId, experimentId);
      const userRelativePath = this.getUserPodRelativePath(userId, experimentId);
      const cardTriples = `@prefix foaf: <http://xmlns.com/foaf/0.1/>.
@prefix solid: <http://www.w3.org/ns/solid/terms#>.

<>
    a foaf:PersonalProfileDocument;
    foaf:maker <${userPodUrl}/profile/card#me>;
    foaf:primaryTopic <${userPodUrl}/profile/card#me>.

<${userPodUrl}/profile/card#me>
    solid:oidcIssuer <${this.podProviderUrl}>;
    a foaf:Person;
    foaf:name "User ${i}" .
`;
      const cardFilePath = `${this.outputDirectory}/${userRelativePath}/profile/card$.ttl`;
      fs.mkdirSync(path.dirname(cardFilePath), { recursive: true });
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
      fs.mkdirSync(path.dirname(messageBoxFilePath), { recursive: true });
      fs.writeFileSync(messageBoxFilePath, messageBoxTriples);
    }
  }
}

// Worker thread execution - runs when this file is loaded as a worker
if (!isMainThread && parentPort) {
  runQueriesInWorker(workerData.podName, workerData.roomName, workerData.linkTraversalMethod)
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
