import * as fs from 'fs';
import * as path from 'path';
import {randomUUID} from 'crypto';

export interface ServerDistributionOptions {
  podsPerServer?: number;
  solidPortBase?: number;
  umaPortBase?: number;
}

export interface ServerInstanceContext {
  index: number;
  solidPort: number;
  umaPort: number;
  relativePath: string;
  absolutePath: string;
  solidBaseUrl: string;
  umaBaseUrl: string;
}

export interface PodContext {
  name: string;
  relativePath: string;
  absolutePath: string;
  baseUrl: string;
  webId: string;
  email: string;
  server: ServerInstanceContext;
}

export interface ExperimentSetup {
  queryUser: PodContext;
  servers: ServerInstanceContext[];
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return undefined;
    }
    value = parsed;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return undefined;
}

function parseNonNegativeInteger(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return undefined;
    }
    value = parsed;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return undefined;
}

export class DataGenerator {
  protected readonly experimentConfig: any;
  protected readonly outputDirectory: string;
  protected readonly aggregatorIdStore = new Map<string, string>();

  private readonly podsPerServer: number;
  private readonly solidPortBase: number;
  private readonly umaPortBase: number;

  private readonly podContexts = new Map<string, PodContext>();
  private readonly servers = new Map<number, ServerInstanceContext>();
  private readonly serverPodNames = new Map<number, string[]>();
  private nextServerIndex = 0;

  constructor(outputDirectory: string, experimentConfig: any, options: ServerDistributionOptions = {}) {
    this.experimentConfig = experimentConfig;
    this.outputDirectory = outputDirectory;

    const envPodsPerServer = parsePositiveInteger(process.env.PODS_PER_SERVER);
    const configPodsPerServer = parsePositiveInteger(experimentConfig?.podsPerServer);
    const rawPodsPerServer = options.podsPerServer ?? envPodsPerServer ?? configPodsPerServer;
    this.podsPerServer = rawPodsPerServer ?? Number.POSITIVE_INFINITY;

    const envSolidPortBase = parseNonNegativeInteger(process.env.SOLID_PORT_BASE);
    const configSolidPortBase = parseNonNegativeInteger(experimentConfig?.solidPortBase);
    const rawSolidPortBase = options.solidPortBase ?? envSolidPortBase ?? configSolidPortBase;
    this.solidPortBase = rawSolidPortBase ?? 3000;

    const envUmaPortBase = parseNonNegativeInteger(process.env.UMA_PORT_BASE);
    const configUmaPortBase = parseNonNegativeInteger(experimentConfig?.umaPortBase);
    const rawUmaPortBase = options.umaPortBase ?? envUmaPortBase ?? configUmaPortBase;
    this.umaPortBase = rawUmaPortBase ?? 4000;
  }

  protected removeGeneratedData(): void {
    fs.rmSync(this.outputDirectory, {recursive: true, force: true});
  }

  protected getOrCreatePodContext(podName: string): PodContext {
    const existing = this.podContexts.get(podName);
    if (existing) {
      return existing;
    }

    let serverIndex = this.nextServerIndex;
    let podsForServer = this.serverPodNames.get(serverIndex);
    if (!podsForServer) {
      podsForServer = [];
      this.serverPodNames.set(serverIndex, podsForServer);
    }

    if (Number.isFinite(this.podsPerServer) && this.podsPerServer > 0 && podsForServer.length >= this.podsPerServer) {
      serverIndex = ++this.nextServerIndex;
      podsForServer = [];
      this.serverPodNames.set(serverIndex, podsForServer);
    }

    if (serverIndex > 999) {
      throw new Error(`Exceeded maximum supported server count (1000). Attempted to create server index ${serverIndex}.`);
    }

    const server = this.getOrCreateServerContext(serverIndex);
    const relativePath = `${server.relativePath}/${podName}`;
    const absolutePath = path.join(server.absolutePath, podName);
    const baseUrl = `${server.solidBaseUrl}${podName}`;

    const context: PodContext = {
      name: podName,
      relativePath,
      absolutePath,
      baseUrl,
      webId: `${baseUrl}/profile/card#me`,
      email: `${podName}@example.org`,
      server,
    };

    podsForServer.push(podName);
    this.podContexts.set(podName, context);
    return context;
  }

  protected getPodNamesForServer(serverIndex: number): string[] {
    return this.serverPodNames.get(serverIndex) ?? [];
  }

  public getServers(): ServerInstanceContext[] {
    return Array.from(this.servers.values()).sort((a, b) => a.index - b.index);
  }

  public getPodContextByName(podName: string): PodContext {
    const context = this.podContexts.get(podName);
    if (!context) {
      throw new Error(`No pod context registered for pod "${podName}".`);
    }
    return context;
  }

  protected finalizeGeneration(queryUser: PodContext): ExperimentSetup {
    for (const server of this.getServers()) {
      this.generateServerMetadata(server);
    }
    return {
      queryUser,
      servers: this.getServers(),
    };
  }

  private getOrCreateServerContext(index: number): ServerInstanceContext {
    const existing = this.servers.get(index);
    if (existing) {
      return existing;
    }

    const relativePath = `server-${index}`;
    const absolutePath = path.join(this.outputDirectory, relativePath);
    const solidPort = this.solidPortBase + index;
    const umaPort = this.umaPortBase + index;

    const context: ServerInstanceContext = {
      index,
      solidPort,
      umaPort,
      relativePath,
      absolutePath,
      solidBaseUrl: `http://localhost:${solidPort}/`,
      umaBaseUrl: `http://localhost:${umaPort}/`,
    };

    this.servers.set(index, context);
    return context;
  }

  private generateServerMetadata(server: ServerInstanceContext): void {
    const podNames = this.getPodNamesForServer(server.index);
    if (podNames.length === 0) {
      return;
    }

    fs.mkdirSync(server.absolutePath, {recursive: true});

    const internalDir = path.join(server.absolutePath, '.internal');
    const accountsDir = path.join(internalDir, 'accounts');
    const idpKeysDir = path.join(internalDir, 'idp/keys');
    const accountsDataDir = path.join(accountsDir, 'data');
    const accountsIndexDir = path.join(accountsDir, 'index');
    const setupDir = path.join(internalDir, 'setup');

    fs.mkdirSync(internalDir, {recursive: true});
    fs.mkdirSync(idpKeysDir, {recursive: true});
    fs.mkdirSync(accountsDataDir, {recursive: true});
    fs.mkdirSync(accountsIndexDir, {recursive: true});
    fs.mkdirSync(setupDir, {recursive: true});

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

    for (const podName of podNames) {
      const info = this.generateAccountData(server, accountsDataDir, podName);
      accountsInfo.push(info);
    }

    this.generateIndexFiles(accountsIndexDir, accountsInfo);
    this.generateSetupFiles(server, setupDir);

    const idpKeysData = {
      key: 'idp/keys/jwks',
      payload: {
        keys: [
          {
            kty: 'EC',
            x: '9CgO8ZV8qCMNtZVbNyS4l22DJKwQ1nr04qBWLe1FL74',
            y: 'G8uXhimL9buvA8376nOBPEvMuc90HkbP6gQiM7RFwL8',
            crv: 'P-256',
            d: 'LQPy_aN2yL25oruqbRuB2Z5xWKAw22MFFF0EeI11iA0',
            alg: 'ES256',
          },
        ],
      },
    };
    fs.writeFileSync(
      path.join(idpKeysDir, 'jwks$.json'),
      JSON.stringify(idpKeysData),
    );

    const metaData = `<${server.solidBaseUrl}> a <http://www.w3.org/ns/pim/space#Storage>.\n`;
    fs.writeFileSync(
      path.join(server.absolutePath, '.meta'),
      metaData,
    );

    fs.writeFileSync(
      path.join(server.absolutePath, 'index.html'),
      HTMLDATA,
    );
  }

  private generateAccountData(
    server: ServerInstanceContext,
    accountsDataDir: string,
    podName: string,
  ) {
    const podContext = this.getPodContextByName(podName);

    const accountId = randomUUID();
    const passwordId = randomUUID();
    const podId = randomUUID();
    const ownerId = randomUUID();
    const webIdLinkId = randomUUID();

    const accountData = {
      key: `accounts/data/${accountId}`,
      payload: {
        linkedLoginsCount: 1,
        id: accountId,
        '**password**': {
          [passwordId]: {
            accountId,
            email: podContext.email,
            password: '$2a$10$z6jXAFtogul3L42NqdEXQe.1sKVH8p5y97uOQrIyiWLX4zZJvfymG',
            verified: true,
            id: passwordId,
          },
        },
        '**clientCredentials**': {},
        '**pod**': {
          [podId]: {
            baseUrl: `${podContext.baseUrl}/`,
            accountId,
            id: podId,
            '**owner**': {
              [ownerId]: {
                podId,
                webId: podContext.webId,
                visible: false,
                id: ownerId,
              },
            },
          },
        },
        '**webIdLink**': {
          [webIdLinkId]: {
            webId: podContext.webId,
            accountId,
            id: webIdLinkId,
          },
        },
      },
    };

    const filename = `${accountId}$.json`;
    fs.writeFileSync(
      path.join(accountsDataDir, filename),
      JSON.stringify(accountData),
    );

    return {
      accountId,
      passwordId,
      podId,
      ownerId,
      webIdLinkId,
      podName: podContext.name,
      email: podContext.email,
      webId: podContext.webId,
      baseUrl: `${podContext.baseUrl}/`,
    };
  }

  private generateIndexFiles(accountsIndexDir: string, accountsInfo: Array<any>) {
    const ownerDir = path.join(accountsIndexDir, 'owner');
    const passwordDir = path.join(accountsIndexDir, 'password');
    const passwordEmailDir = path.join(passwordDir, 'email');
    const podDir = path.join(accountsIndexDir, 'pod');
    const podBaseUrlDir = path.join(podDir, 'baseUrl');
    const webIdLinkDir = path.join(accountsIndexDir, 'webIdLink');
    const webIdLinkWebIdDir = path.join(webIdLinkDir, 'webId');

    fs.mkdirSync(ownerDir, {recursive: true});
    fs.mkdirSync(passwordEmailDir, {recursive: true});
    fs.mkdirSync(podBaseUrlDir, {recursive: true});
    fs.mkdirSync(webIdLinkWebIdDir, {recursive: true});

    for (const info of accountsInfo) {
      const ownerIndexData = {
        key: `accounts/index/owner/${info.ownerId}`,
        payload: [info.accountId],
      };
      fs.writeFileSync(
        path.join(ownerDir, `${info.ownerId}$.json`),
        JSON.stringify(ownerIndexData),
      );

      const passwordIndexData = {
        key: `accounts/index/password/${info.passwordId}`,
        payload: [info.accountId],
      };
      fs.writeFileSync(
        path.join(passwordDir, `${info.passwordId}$.json`),
        JSON.stringify(passwordIndexData),
      );

      const encodedEmail = encodeURIComponent(info.email);
      const passwordEmailIndexData = {
        key: `accounts/index/password/email/${encodedEmail}`,
        payload: [info.accountId],
      };
      fs.writeFileSync(
        path.join(passwordEmailDir, `${info.email}$.json`),
        JSON.stringify(passwordEmailIndexData),
      );

      const podIndexData = {
        key: `accounts/index/pod/${info.podId}`,
        payload: [info.accountId],
      };
      fs.writeFileSync(
        path.join(podDir, `${info.podId}$.json`),
        JSON.stringify(podIndexData),
      );

      const encodedBaseUrl = encodeURIComponent(info.baseUrl);
      const podBaseUrlIndexData = {
        key: `accounts/index/pod/baseUrl/${encodedBaseUrl}`,
        payload: [info.accountId],
      };
      fs.writeFileSync(
        path.join(podBaseUrlDir, `${encodedBaseUrl}$.json`),
        JSON.stringify(podBaseUrlIndexData),
      );

      const webIdLinkIndexData = {
        key: `accounts/index/webIdLink/${info.webIdLinkId}`,
        payload: [info.accountId],
      };
      fs.writeFileSync(
        path.join(webIdLinkDir, `${info.webIdLinkId}$.json`),
        JSON.stringify(webIdLinkIndexData),
      );

      const encodedWebId = this.encodeWebIdForFilename(info.webId);
      const webIdLinkWebIdIndexData = {
        key: `accounts/index/webIdLink/webId/${encodedWebId}`,
        payload: [info.accountId],
      };
      fs.writeFileSync(
        path.join(webIdLinkWebIdDir, `${encodedWebId}$.json`),
        JSON.stringify(webIdLinkWebIdIndexData),
      );
    }
  }

  private encodeWebIdForFilename(webId: string): string {
    return encodeURIComponent(webId).replace(/%23/g, '#');
  }

  private generateSetupFiles(server: ServerInstanceContext, setupDir: string) {
    const baseUrlData = {
      key: 'setup/current-base-url',
      payload: server.solidBaseUrl,
    };
    fs.writeFileSync(
      path.join(setupDir, 'current-base-url$.json'),
      JSON.stringify(baseUrlData),
    );

    const versionData = {
      key: 'setup/current-server-version',
      payload: '7.1.7',
    };
    fs.writeFileSync(
      path.join(setupDir, 'current-server-version$.json'),
      JSON.stringify(versionData),
    );

    const rootInitData = {
      key: 'setup/rootInitialized',
      payload: true,
    };
    fs.writeFileSync(
      path.join(setupDir, 'rootInitialized$.json'),
      JSON.stringify(rootInitData),
    );

    const migrationData = {
      key: 'setup/v6-migration',
      payload: true,
    };
    fs.writeFileSync(
      path.join(setupDir, 'v6-migration$.json'),
      JSON.stringify(migrationData),
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
