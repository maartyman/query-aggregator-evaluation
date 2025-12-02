import {DataGenerator, PodContext, ServerDistributionOptions} from "../data-generator";

// generates multiple pods with the necessary triples related to the watch party use case

// required data per pod/pod schema:
// profile/card
/*
@prefix foaf: <http://xmlns.com/foaf/0.1/>.
@prefix solid: <http://www.w3.org/ns/solid/terms#>.

<>
    a foaf:PersonalProfileDocument;
    foaf:maker <http://localhost:8000/user1/profile/card#me>;
    foaf:primaryTopic <http://localhost:8000/user1/profile/card#me>.

<http://localhost:8000/user1/profile/card#me>
    solid:oidcIssuer <http://localhost:8000/>;
    a foaf:Person;
    foaf:name "User 1" .
*/

// watchparties/myMessages/{uuid1}
/*
<#outbox> a <http://schema.org/CreativeWorkSeries>;
    <http://schema.org/about> <http://localhost:8000/user1/watchparties/myRooms/els2025-09-25t125000168z/room#3d21648f-e362-494f-87b2-6bf9d52ca3ab>;
    <http://schema.org/creator> <http://localhost:8000/user1/profile/card#me>;
    <http://schema.org/hasPart> <#175880471316709052043691171556>, <#175880473547504871005324642216>.
<#175880471316709052043691171556> a <http://schema.org/Message>;
    <http://schema.org/sender> <http://localhost:8000/user1/profile/card#me>;
    <http://schema.org/isPartOf> <#outbox>;
    <http://schema.org/dateSent> "2025-09-25T12:51:53.167Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>;
    <http://schema.org/text> "\U0001f44b".
<#175880473547504871005324642216> a <http://schema.org/Message>;
    <http://schema.org/sender> <http://localhost:8000/user1/profile/card#me>;
    <http://schema.org/isPartOf> <#outbox>;
    <http://schema.org/dateSent> "2025-09-25T12:52:15.475Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>;
    <http://schema.org/text> "Hello".
*/

// watchparties/myRooms/{uuid2}/register
/*
<#httpspodplaygroundsolidlabbeuser1profilecardme> a <http://schema.org/RegisterAction>;
    <http://schema.org/agent> <http://localhost:8000/user1/profile/card#me>;
    <http://schema.org/object> <http://localhost:8000/user1/watchparties/myRooms/els2025-09-25t125000168z/room#3d21648f-e362-494f-87b2-6bf9d52ca3ab>;
    <http://schema.org/additionalType> <http://localhost:8000/user1/watchparties/myMessages/MSGhttpspodplaygroundsolidlabbeuser1watchpartiesmyroomsels2025-09-25t125000168zroom3d21648f-e362-494f-87b2-6bf9d52ca3ab#outbox>;
    <http://schema.org/actionStatus> <http://schema.org/CompletedActionStatus>.
<#httpspodplaygroundsolidlabbeuser2profilecardme> a <http://schema.org/RegisterAction>;
    <http://schema.org/agent> <http://localhost:8000/user2/profile/card#me>;
    <http://schema.org/object> <http://localhost:8000/user1/watchparties/myRooms/els2025-09-25t125000168z/room#3d21648f-e362-494f-87b2-6bf9d52ca3ab>;
    <http://schema.org/additionalType> <http://localhost:8000/user2/watchparties/myMessages/MSGhttpspodplaygroundsolidlabbeuser1watchpartiesmyroomsels2025-09-25t125000168zroom3d21648f-e362-494f-87b2-6bf9d52ca3ab#outbox>;
    <http://schema.org/actionStatus> <http://schema.org/CompletedActionStatus>.
*/

// watchparties/myRooms/{uuid2}/room
/*
<#3d21648f-e362-494f-87b2-6bf9d52ca3ab> a <http://schema.org/EventSeries>;
    <http://schema.org/description> "Solid Watchparty";
    <http://schema.org/name> "Els";
    <http://schema.org/organizer> <http://localhost:8000/user1/profile/card#me>;
    <http://schema.org/startDate> "2025-09-25T12:50:00.168Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>;
    <http://schema.org/attendee> <http://localhost:8000/user1/profile/card#me>, <http://localhost:8000/user2/profile/card#me>;
    <http://schema.org/subjectOf> <http://localhost:8000/user1/watchparties/myMessages/MSGhttpspodplaygroundsolidlabbeuser1watchpartiesmyroomsels2025-09-25t125000168zroom3d21648f-e362-494f-87b2-6bf9d52ca3ab#outbox>, <http://localhost:8000/user2/watchparties/myMessages/MSGhttpspodplaygroundsolidlabbeuser1watchpartiesmyroomsels2025-09-25t125000168zroom3d21648f-e362-494f-87b2-6bf9d52ca3ab#outbox>.
*/

export class WatchpartyDataGenerator extends DataGenerator {
    protected queryUser;
    protected room;

    private getExperimentPrefix(experimentId: string) {
        return `${experimentId}`;
    }

    protected getPodName(user: string, experimentId: string): string {
        return `${this.getExperimentPrefix(experimentId)}_${user}`;
    }

    protected getUserPodContext(user: string, experimentId: string): PodContext {
        return this.getOrCreatePodContext(this.getPodName(user, experimentId));
    }

    protected getUserPodRelativePath(user: string, experimentId: string) {
        return this.getUserPodContext(user, experimentId).relativePath;
    }

    protected getUserPodUrl(user: string, experimentId: string) {
        return this.getUserPodContext(user, experimentId).baseUrl;
    }

    protected getUserIssuerUrl(user: string, experimentId: string) {
        return this.getUserPodContext(user, experimentId).server.solidBaseUrl;
    }

    public constructor(
      outputDirectory: string,
      experimentConfig: any,
      distributionOptions: ServerDistributionOptions = {},
      queryUser: string = "query-user",
      room: string = "room",
    ) {
        super(outputDirectory, experimentConfig, distributionOptions);
        this.queryUser = queryUser;
        this.room = room;
    }
}
