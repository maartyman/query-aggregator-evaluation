import {createDpopHeader, generateDpopKeyPair, KeyPair} from "@inrupt/solid-client-authn-core";
import {EventEmitter} from "node:events";

export class Auth {
  private readonly podName: string;
  private dpopKey: KeyPair | undefined;
  private authString: string | undefined;
  private accessToken: string | undefined;
  private activeRequests: number = 0;
  private readonly maxConcurrentRequests: number = 20;
  private requestQueue: Array<() => void> = [];

  constructor(podName: string) {
    this.podName = podName;
  }

  async init() {
    this.dpopKey = await generateDpopKeyPair();

    let indexResponse = await fetch('http://localhost:3000/.account/');
    let controls = (await indexResponse.json()).controls;

    let response = await fetch(controls.password.login, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `${this.podName}@example.org`, password: 'password' }),
    });
    if (!response.ok) {
      throw new Error('Login failed:'+ await response.text());
    }
    const { authorization } = await response.json();

    indexResponse = await fetch('http://localhost:3000/.account/', {
      headers: { authorization: `CSS-Account-Token ${authorization}` }
    });
    if (!indexResponse.ok) {
      throw new Error('Login failed:' + await indexResponse.text());
    }
    controls = (await indexResponse.json()).controls;

    response = await fetch(controls.account.clientCredentials, {
      method: 'POST',
      headers: { authorization: `CSS-Account-Token ${authorization}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'my-token', webId: `http://localhost:3000/${this.podName}/profile/card#me` }),
    });

    const { id, secret } = await response.json();

    this.authString = `${encodeURIComponent(id)}:${encodeURIComponent(secret)}`;
  }

  async getAccessToken() {
    if (!this.authString || !this.dpopKey) {
      throw new Error('Not initialized');
    }

    let response = await fetch('http://localhost:3000/.oidc/token', {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(this.authString).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
        dpop: await createDpopHeader('http://localhost:3000/.oidc/token', 'POST', this.dpopKey),
      },
      body: 'grant_type=client_credentials&scope=webid',
    });

    const accessTokenJson = await response.json();
    this.accessToken = accessTokenJson.access_token;
  }

  private async createClaim(ticket: string) {
    if (!this.accessToken || !this.dpopKey) {
      throw new Error('Not initialized');
    }
    return {
      grant_type: 'urn:ietf:params:oauth:grant-type:uma-ticket',
      ticket,
      claim_token: JSON.stringify({
        'Authorization': 'DPop ' + this.accessToken,
        'DPoP': await createDpopHeader('http://localhost:4000/uma/token', 'POST', this.dpopKey)
      }),
      claim_token_format: 'http://openid.net/specs/openid-connect-core-1_0.html#IDToken',
    }
  }

  private async acquireRequestSlot(): Promise<void> {
    return new Promise((resolve) => {
      if (this.activeRequests < this.maxConcurrentRequests) {
        this.activeRequests++;
        resolve();
      } else {
        this.requestQueue.push(() => {
          this.activeRequests++;
          resolve();
        });
      }
    });
  }

  private releaseRequestSlot(): void {
    this.activeRequests--;
    if (this.requestQueue.length > 0) {
      const nextRequest = this.requestQueue.shift();
      if (nextRequest) {
        nextRequest();
      }
    }
  }

  private async throttledFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    await this.acquireRequestSlot();
    try {
      return await fetch(input, init);
    } finally {
      this.releaseRequestSlot();
    }
  }

  async fetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const response = await this.throttledFetch(input, init);
    if (response.status !== 401) {
      return response;
    }
    const wwwAuthenticateHeader = response.headers.get("WWW-Authenticate")!
    const {as_uri, ticket} = Object.fromEntries(wwwAuthenticateHeader.replace(/^UMA /, '').split(', ').map(
      param => param.split('=').map(s => s.replace(/"/g, ''))
    ));

    const uma2ConfigResponse = await fetch(`${as_uri}/.well-known/uma2-configuration`);
    if (!uma2ConfigResponse.ok) {
      return response;
    }
    const uma2Config = await uma2ConfigResponse.json();
    const tokenEndpoint = uma2Config.token_endpoint;

    const asRequestResponse = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(await this.createClaim(ticket)),
    });
    if (!asRequestResponse.ok) {
      return asRequestResponse;
    }

    const asResponse: any = await asRequestResponse.json();
    if (!init) {
      init = {};
    }
    init.headers = { 'Authorization': `${asResponse.token_type} ${asResponse.access_token}` };

    return await this.throttledFetch(input, init);
  }

  async sse(input: string): Promise<EventEmitter> {
    const response = await fetch(input, {
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
      },
    });

    const wwwAuthenticateHeader = response.headers.get("WWW-Authenticate")!
    const {as_uri, ticket} = Object.fromEntries(wwwAuthenticateHeader.replace(/^UMA /, '').split(', ').map(
      param => param.split('=').map(s => s.replace(/"/g, ''))
    ));

    const serviceEndpoint = response.headers.get("Link")?.match(/<([^>]+)>;\s*rel="service_token_endpoint"/)?.[1];

    const uma2ConfigResponse = await fetch(`${as_uri}/.well-known/uma2-configuration`);
    if (!uma2ConfigResponse.ok) {
      throw new Error('cannot get UMA2 configuration' + await uma2ConfigResponse.text());
    }
    const uma2Config = await uma2ConfigResponse.json();
    const tokenEndpoint = uma2Config.token_endpoint;

    const asRequestResponse = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(await this.createClaim(ticket)),
    });
    if (!asRequestResponse.ok) {
      throw new Error('cannot retrieve access token' + await asRequestResponse.text());
    }

    const asResponse: any = await asRequestResponse.json();

    const serviceTokenResponse = await fetch(serviceEndpoint!, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        'Authorization': `${asResponse.token_type} ${asResponse.access_token}`
      },
      body: JSON.stringify({
        "resource_url": input,
        "resource_scopes": ["urn:example:css:modes:continuous:read"]
      }),
    });

    if (!serviceTokenResponse.ok) {
      throw new Error('cannot retrieve service token: ' + await serviceTokenResponse.text());
    }

    const ee = new EventEmitter();

    const serviceTokenJson = await serviceTokenResponse.json();
    console.log("serviceTokenJson: ", JSON.stringify(serviceTokenJson))

    const authenticatedResponse = await fetch(input, {
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        'Authorization': `Bearer ${serviceTokenJson.access_token}`
      },
    });
    const nodeStream = authenticatedResponse.body as any;
    let buffer = '';
    let currentEventType = '';

    nodeStream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEventType = line.substring(7);
          continue;
        }
        if (line.startsWith('data: ')) {
          const data = line.substring(6);
          ee.emit('message', {
            eventType: currentEventType,
            data: JSON.parse(data)
          });
        }
      }
    });
    nodeStream.on('end', () => ee.emit('end'));
    nodeStream.on('error', (e: Error) => ee.emit('error', e));

    return ee;
  }
}
