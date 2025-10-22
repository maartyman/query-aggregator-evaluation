import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {Auth} from "./utils/auth";
import WebSocket from 'ws';
import {EventEmitter} from "node:events";

export class DataGenerator {
  protected podProviderUrl;
  protected experimentConfig;
  protected outputDirectory;
  private pipelineEndpoint = 'http://localhost:5000/config/actors';
  protected aggregatorIdStore= new Map<string, string>();

  constructor(outputDirectory: string, experimentConfig: any, podProviderUrl: string) {
    this.podProviderUrl = podProviderUrl;
    this.experimentConfig = experimentConfig;
    this.outputDirectory = outputDirectory;
  }

  protected async createAggregatorService(auth: Auth, FnoDescription: string): Promise<string> {
    const response = await auth.fetch(this.pipelineEndpoint, {
      method: "POST",
      headers: {
        "content-type": "text/turtle"
      },
      body: FnoDescription,
    });
    if (!response.ok) {
      throw new Error(`Failed to configure aggregator: ${await response.text()}`);
    }
    return (await response.json()).id;
  }

  protected async getAggregatorService(auth: Auth, serviceId: string): Promise<any> {
    const response = await auth.fetch(`${this.pipelineEndpoint}/${serviceId}/`, {
      method: "GET"
    });
    if (!response.ok) {
      throw new Error(`Failed to get aggregator: ${await response.text()}`);
    }
    return await response.json();
  }

  protected async waitForAggregatorService(auth: Auth, serviceId: string): Promise<void> {
    return new Promise(async (resolve, reject) => {
      let sse: undefined | EventEmitter = undefined;
      while (sse === undefined) {
        try {
          sse = await auth.sse(serviceId);
        } catch (e) {
          console.log(`Aggregator service ${serviceId} not yet available, retrying...`);
          sse = undefined;
          await new Promise(r => setTimeout(r, 500));
        }
      }
      sse!.on("message", (message) => {
        if (message.eventType === "up-to-date") {
          console.log(`Aggregator service ${serviceId} is up-to-date.`);
          resolve();
        }
      });

      sse!.on("end", () => {
        reject(new Error(`Aggregator service ${serviceId} stream ended before reaching up-to-date state.`));
      });

      sse!.on("error", (error) => {
        reject(new Error(`Error while waiting for aggregator service ${serviceId}: ${error.message}`));
      });
    });
  }

  protected generateMetaData() {
    const internalDir = path.join(this.outputDirectory, '.internal');
    const accountsDir = path.join(internalDir, 'accounts');
    const idpKeysDir = path.join(internalDir, 'idp/keys');
    const accountsDataDir = path.join(accountsDir, 'data');
    const accountsIndexDir = path.join(accountsDir, 'index');
    const setupDir = path.join(internalDir, 'setup');

    // Create directory structure
    fs.mkdirSync(internalDir, { recursive: true });
    fs.mkdirSync(idpKeysDir, { recursive: true });
    fs.mkdirSync(accountsDataDir, { recursive: true });
    fs.mkdirSync(accountsIndexDir, { recursive: true });
    fs.mkdirSync(setupDir, { recursive: true });

    // Get all pod directories
    const podDirs = fs.readdirSync(this.outputDirectory, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory() && !dirent.name.startsWith('.'))
      .map(dirent => dirent.name);

    // Store account info for index generation
    const accountsInfo: Array<{
      accountId: string;
      passwordId: string;
      podId: string;
      ownerId: string;
      webIdLinkId: string;
      podName: string;
      email: string;
      webId: string;
      baseUrl: string;
    }> = [];

    // Generate account data for each pod
    for (const podName of podDirs) {
      const info = this.generateAccountData(accountsDataDir, podName);
      accountsInfo.push(info);
    }

    // Generate index files
    this.generateIndexFiles(accountsIndexDir, accountsInfo);

    // Generate setup files
    this.generateSetupFiles(setupDir);

    // .meta
    const idpKeysData = {
      "key":"idp/keys/jwks",
      "payload":{
        "keys":[
          {
            "kty":"EC",
            "x":"9CgO8ZV8qCMNtZVbNyS4l22DJKwQ1nr04qBWLe1FL74",
            "y":"G8uXhimL9buvA8376nOBPEvMuc90HkbP6gQiM7RFwL8",
            "crv":"P-256",
            "d":"LQPy_aN2yL25oruqbRuB2Z5xWKAw22MFFF0EeI11iA0",
            "alg":"ES256"
          }
        ]
      }
    }
    fs.writeFileSync(
      path.join(idpKeysDir, 'jwks$.json'),
      JSON.stringify(idpKeysData)
    );

    // .meta
    const metaData = "<http://localhost:3000/> a <http://www.w3.org/ns/pim/space#Storage>.\n"
    fs.writeFileSync(
      path.join(this.outputDirectory, '.meta'),
      metaData
    );

    // index.html
    fs.writeFileSync(
      path.join(this.outputDirectory, 'index.html'),
      HTMLDATA
    );
  }

  private generateAccountData(accountsDataDir: string, podName: string) {
    const accountId = randomUUID();
    const passwordId = randomUUID();
    const podId = randomUUID();
    const ownerId = randomUUID();
    const webIdLinkId = randomUUID();

    const webId = `${this.podProviderUrl}${podName}/profile/card#me`;
    const baseUrl = `${this.podProviderUrl}${podName}/`;
    const email = `${podName}@example.org`;

    const accountData = {
      key: `accounts/data/${accountId}`,
      payload: {
        linkedLoginsCount: 1,
        id: accountId,
        "**password**": {
          [passwordId]: {
            accountId: accountId,
            email: email,
            password: "$2a$10$z6jXAFtogul3L42NqdEXQe.1sKVH8p5y97uOQrIyiWLX4zZJvfymG", // bcrypt hash of 'password'
            verified: true,
            id: passwordId
          }
        },
        "**clientCredentials**": {},
        "**pod**": {
          [podId]: {
            baseUrl: baseUrl,
            accountId: accountId,
            id: podId,
            "**owner**": {
              [ownerId]: {
                podId: podId,
                webId: webId,
                visible: false,
                id: ownerId
              }
            }
          }
        },
        "**webIdLink**": {
          [webIdLinkId]: {
            webId: webId,
            accountId: accountId,
            id: webIdLinkId
          }
        }
      }
    };

    const filename = `${accountId}$.json`;
    fs.writeFileSync(
      path.join(accountsDataDir, filename),
      JSON.stringify(accountData)
    );

    return {
      accountId,
      passwordId,
      podId,
      ownerId,
      webIdLinkId,
      podName,
      email,
      webId,
      baseUrl
    };
  }

  private generateIndexFiles(accountsIndexDir: string, accountsInfo: Array<any>) {
    // Create index directory structure
    const ownerDir = path.join(accountsIndexDir, 'owner');
    const passwordDir = path.join(accountsIndexDir, 'password');
    const passwordEmailDir = path.join(passwordDir, 'email');
    const podDir = path.join(accountsIndexDir, 'pod');
    const podBaseUrlDir = path.join(podDir, 'baseUrl');
    const webIdLinkDir = path.join(accountsIndexDir, 'webIdLink');
    const webIdLinkWebIdDir = path.join(webIdLinkDir, 'webId');

    fs.mkdirSync(ownerDir, { recursive: true });
    fs.mkdirSync(passwordEmailDir, { recursive: true });
    fs.mkdirSync(podBaseUrlDir, { recursive: true });
    fs.mkdirSync(webIdLinkWebIdDir, { recursive: true });

    for (const info of accountsInfo) {
      // Owner index files
      const ownerIndexData = {
        key: `accounts/index/owner/${info.ownerId}`,
        payload: [info.accountId]
      };
      fs.writeFileSync(
        path.join(ownerDir, `${info.ownerId}$.json`),
        JSON.stringify(ownerIndexData)
      );

      // Password index files
      const passwordIndexData = {
        key: `accounts/index/password/${info.passwordId}`,
        payload: [info.accountId]
      };
      fs.writeFileSync(
        path.join(passwordDir, `${info.passwordId}$.json`),
        JSON.stringify(passwordIndexData)
      );

      // Password email index files
      const encodedEmail = encodeURIComponent(info.email);
      const passwordEmailIndexData = {
        key: `accounts/index/password/email/${encodedEmail}`,
        payload: [info.accountId]
      };
      fs.writeFileSync(
        path.join(passwordEmailDir, `${info.email}$.json`),
        JSON.stringify(passwordEmailIndexData)
      );

      // Pod index files
      const podIndexData = {
        key: `accounts/index/pod/${info.podId}`,
        payload: [info.accountId]
      };
      fs.writeFileSync(
        path.join(podDir, `${info.podId}$.json`),
        JSON.stringify(podIndexData)
      );

      // Pod baseUrl index files
      const encodedBaseUrl = encodeURIComponent(info.baseUrl);
      const podBaseUrlIndexData = {
        key: `accounts/index/pod/baseUrl/${encodedBaseUrl}`,
        payload: [info.accountId]
      };
      fs.writeFileSync(
        path.join(podBaseUrlDir, `${encodedBaseUrl}$.json`),
        JSON.stringify(podBaseUrlIndexData)
      );

      // WebIdLink index files
      const webIdLinkIndexData = {
        key: `accounts/index/webIdLink/${info.webIdLinkId}`,
        payload: [info.accountId]
      };
      fs.writeFileSync(
        path.join(webIdLinkDir, `${info.webIdLinkId}$.json`),
        JSON.stringify(webIdLinkIndexData)
      );

      // WebIdLink webId index files - preserve # character
      const encodedWebId = this.encodeWebIdForFilename(info.webId);
      const webIdLinkWebIdIndexData = {
        key: `accounts/index/webIdLink/webId/${encodedWebId}`,
        payload: [info.accountId]
      };
      fs.writeFileSync(
        path.join(webIdLinkWebIdDir, `${encodedWebId}$.json`),
        JSON.stringify(webIdLinkWebIdIndexData)
      );
    }
  }

  private encodeWebIdForFilename(webId: string): string {
    // Encode URI components but preserve the # character
    return encodeURIComponent(webId).replace(/%23/g, '#');
  }

  private generateSetupFiles(setupDir: string) {
    // Current base URL
    const baseUrlData = {
      key: "setup/current-base-url",
      payload: this.podProviderUrl
    };
    fs.writeFileSync(
      path.join(setupDir, 'current-base-url$.json'),
      JSON.stringify(baseUrlData)
    );

    // Server version
    const versionData = {
      key: "setup/current-server-version",
      payload: "7.1.7"
    };
    fs.writeFileSync(
      path.join(setupDir, 'current-server-version$.json'),
      JSON.stringify(versionData)
    );

    // Root initialized
    const rootInitData = {
      key: "setup/rootInitialized",
      payload: true
    };
    fs.writeFileSync(
      path.join(setupDir, 'rootInitialized$.json'),
      JSON.stringify(rootInitData)
    );

    // V6 migration
    const migrationData = {
      key: "setup/v6-migration",
      payload: true
    };
    fs.writeFileSync(
      path.join(setupDir, 'v6-migration$.json'),
      JSON.stringify(migrationData)
    );
  }
}

const HTMLDATA = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Community Solid Server</title>
  <link rel="stylesheet" href="./.well-known/css/styles/main.css" type="text/css">
</head>
<body>
  <header>
    <a href=".."><img src="./.well-known/css/images/solid.svg" alt="[Solid logo]" /></a>
    <h1>Community Solid Server</h1>
  </header>
  <main>
    <h1>Welcome to Solid</h1>
    <p>
      This server implements
      the <a href="https://solid.github.io/specification/protocol">Solid protocol</a>
      so you can create your own <a href="https://solidproject.org/about">Solid Pod</a>
      and identity.
    </p>

    <h2 id="users">Getting started as a <em>user</em></h2>
    <p>
      <a id="registration-link" href="./.account/login/password/register/">Sign up for an account</a>
      to get started with your own Pod and WebID.
    </p>
    <p>
      The default configuration stores data only in memory.
      If you want to keep data permanently,
      choose a configuration that saves data to disk instead.
    </p>
    <p>
      To learn more about how this server can be used,
      have a look at the
      <a href="https://github.com/CommunitySolidServer/tutorials/blob/main/getting-started.md">getting started tutorial</a>.
    </p>

    <h2 id="developers">Getting started as a <em>developer</em></h2>
    <p>
      The default configuration includes
      the <strong>ready-to-use root Pod</strong> you're currently looking at.
      <br>
      You can use any of the configurations in the <code>config</code> folder of the server
      to set up an instance of this server with different features.
      Besides the provided configurations,
      you can also fine-tune your own custom configuration using the
      <a href="https://communitysolidserver.github.io/configuration-generator/">configuration generator</a>.
    </p>
    <p>
      You can easily choose any folder on your disk
      to expose as the root Pod with file-based configurations.
      <br>
      Use the <code>--help</code> switch to learn more.
    </p>
    <p>
      Due to certain restrictions in the Solid specification it is usually not allowed
      to both allow data to be written to the root of the server,
      and to enable the creation of new pods.
      This configuration does allow both these options to allow a quick exploration of Solid,
      but other configurations provided will only allow one of those two to be enabled.
    </p>

    <h2>Have a wonderful Solid experience</h2>
    <p>
      <strong>Learn more about Solid
        at <a href="https://solidproject.org/">solidproject.org</a>.</strong>
    </p>
    <p>
      You are warmly invited
      to <a href="https://github.com/CommunitySolidServer/CommunitySolidServer/discussions">share your experiences</a>
      and to <a href="https://github.com/CommunitySolidServer/CommunitySolidServer/issues">report any bugs</a> you encounter.
    </p>
  </main>
  <footer>
    <p>
      ©2019–2025 <a href="https://inrupt.com/">Inrupt Inc.</a>
      and <a href="https://www.imec-int.com/">imec</a>
    </p>
  </footer>
</body>

<script>
  (async() => {
    // Since this page is in the root of the server, we can determine other URLs relative to the current URL
    const res = await fetch('.account/');
    const registrationUrl = (await res.json())?.controls?.html?.password?.register;
    // We specifically want to check if the HTML page that we link to exists
    const resRegistrationPage = await fetch(registrationUrl, { headers: { accept: 'text/html' } });
    const registrationEnabled = registrationUrl && resRegistrationPage.status === 200;

    document.getElementById('registration-enabled').classList[registrationEnabled ? 'remove' : 'add']('hidden');
    document.getElementById('registration-disabled').classList[registrationEnabled ? 'add' : 'remove']('hidden');
    document.getElementById('registration-link').href = registrationUrl;
  })();
</script>
</html>
`;
