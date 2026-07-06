import { App } from '@solid/community-server';
import { ODRL } from '@solidlab/uma';
import { setGlobalLoggerFactory, WinstonLoggerFactory } from 'global-logger-factory';
import { DataFactory as DF, Parser, Store } from 'n3';
import path from 'node:path';
import { getDefaultCssVariables, getPorts, instantiateFromConfig } from '../util/ServerUtil';
import { findTokenEndpoint, generateCredentials, noTokenFetch, tokenFetch, umaFetch } from '../util/UmaUtil';

const [ cssPort, umaPort ] = getPorts('RegistrationPolicy');

describe('Registered resource policy creation', (): void => {
  let umaApp: App;
  let cssApp: App;

  const ownerWebId = `http://localhost:${cssPort}/alice/profile/card#me`;
  const queryWebId = `http://localhost:${cssPort}/bob/profile/card#me`;
  const resource = `http://localhost:${cssPort}/alice/private/registered-resource.txt`;

  beforeAll(async(): Promise<void> => {
    setGlobalLoggerFactory(new WinstonLoggerFactory('off'));

    umaApp = await instantiateFromConfig(
      'urn:uma:default:App',
      path.join(__dirname, '../../packages/uma/config/nondelegated.json'),
      {
        'urn:uma:variables:port': umaPort,
        'urn:uma:variables:baseUrl': `http://localhost:${umaPort}/uma`,
        'urn:uma:variables:eyePath': 'eye',
        'urn:uma:variables:resourceRegistrationAuthorizedWebId': queryWebId,
      }
    ) as App;

    cssApp = await instantiateFromConfig(
      'urn:solid-server:default:App',
      path.join(__dirname, '../../packages/css/config/default.json'),
      {
        ...getDefaultCssVariables(cssPort),
        'urn:solid-server:uma:variable:AuthorizationServer': `http://localhost:${umaPort}/`,
        'urn:solid-server:default:variable:seedConfig': path.join(__dirname, '../../packages/css/config/seed.json'),
      },
    ) as App;

    await Promise.all([ umaApp.start(), cssApp.start() ]);
  });

  afterAll(async(): Promise<void> => {
    await Promise.all([ umaApp.stop(), cssApp.stop() ]);
  });

  it('allows the configured query user to read a resource after CSS registers it with UMA.', async(): Promise<void> => {
    await generateCredentials({
      webId: ownerWebId,
      authorizationServer: `http://localhost:${umaPort}/uma`,
      resourceServer: `http://localhost:${cssPort}/`,
      email: 'alice@example.org',
      password: 'abc123'
    });

    const created = await umaFetch(resource, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'Registered resource content.',
    }, ownerWebId);
    expect(created.status).toBe(201);

    await waitForRegisteredPolicy(resource, ownerWebId, queryWebId);

    const response = await waitForUmaRead(resource, queryWebId);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('Registered resource content.');
  });
});

async function waitForRegisteredPolicy(resource: string, ownerWebId: string, queryWebId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://localhost:${umaPort}/uma/policies`, {
        headers: { authorization: `WebID ${encodeURIComponent(ownerWebId)}` },
      });
      if (response.status !== 200) {
        throw new Error(`Policy fetch failed with status ${response.status}: ${await response.text()}`);
      }

      const store = new Store(new Parser().parse(await response.text()));
      const permissions = store.getSubjects(ODRL.terms.target, DF.namedNode(resource), null)
        .filter((permission) =>
          store.countQuads(permission, ODRL.terms.assignee, DF.namedNode(queryWebId), null) > 0 &&
          store.countQuads(permission, ODRL.terms.action, ODRL.terms.read, null) > 0);
      if (permissions.length > 0) {
        return;
      }

      lastError = new Error(`No registered read policy found for ${queryWebId} on ${resource}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise(resolve => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for registered policy: ${
    lastError instanceof Error ? lastError.message : String(lastError)
  }`);
}

async function waitForUmaRead(resource: string, webId: string): Promise<Response> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const parsedHeader = await noTokenFetch(resource);
      const tokenEndpoint = await findTokenEndpoint(parsedHeader.as_uri);
      const token = await getTokenForRead(parsedHeader.ticket, tokenEndpoint, webId);
      const response = await tokenFetch(token, resource);
      if (response.status === 200) {
        return response;
      }
      lastError = new Error(`Read failed with status ${response.status}: ${await response.text()}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise(resolve => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for configured query-user policy: ${
    lastError instanceof Error ? lastError.message : String(lastError)
  }`);
}

async function getTokenForRead(ticket: string, endpoint: string, webId: string):
  Promise<{ access_token: string, token_type: string }> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:uma-ticket',
      ticket,
      claim_token: encodeURIComponent(webId),
      claim_token_format: 'urn:solidlab:uma:claims:formats:webid',
    }),
  });

  if (response.status !== 200) {
    throw new Error(`Token request failed with status ${response.status}: ${await response.text()}`);
  }

  return response.json() as Promise<{ access_token: string, token_type: string }>;
}
