import {createDpopHeader, generateDpopKeyPair, KeyPair} from "@inrupt/solid-client-authn-core";

export class Auth {
  private readonly podName: string;
  private dpopKey: KeyPair | undefined;
  private authString: string | undefined;
  private accessToken: string | undefined;

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

  async fetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    //const timePoint1 = process.hrtime();
    const response = await fetch(input, init);
    //const timePoint2 = process.hrtime();
    //let diff = (timePoint2[0] - timePoint1[0]) * 1_000 + (timePoint2[1] - timePoint1[1]) / 1_000_000;
    //console.log(`Fetch to ${input} took ${diff} ms, status ${response.status}`);
    if (response.status !== 401) {
      return response;
    }
    const wwwAuthenticateHeader = response.headers.get("WWW-Authenticate")!
    const {as_uri, ticket} = Object.fromEntries(wwwAuthenticateHeader.replace(/^UMA /, '').split(', ').map(
      param => param.split('=').map(s => s.replace(/"/g, ''))
    ));

    const uma2ConfigResponse = await fetch(`${as_uri}/.well-known/uma2-configuration`);
    //const timePoint3 = process.hrtime();
    //diff = (timePoint3[0] - timePoint2[0]) * 1_000 + (timePoint3[1] - timePoint2[1]) / 1_000_000;
    //console.log(`Fetch to ${as_uri}/.well-known/uma2-configuration took ${diff} ms, status ${uma2ConfigResponse.status}`);
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
    //const timePoint4 = process.hrtime();
    //diff = (timePoint4[0] - timePoint3[0]) * 1_000 + (timePoint4[1] - timePoint3[1]) / 1_000_000;
    //console.log(`Fetch to ${tokenEndpoint} with ticket took ${diff} ms, status ${asRequestResponse.status}`);
    if (!asRequestResponse.ok) {
      return asRequestResponse;
    }

    const asResponse: any = await asRequestResponse.json();
    if (!init) {
      init = {};
    }
    init.headers = { 'Authorization': `${asResponse.token_type} ${asResponse.access_token}` };

    const responseFinal = await fetch(input, init);
    //const timePoint5 = process.hrtime();
    //diff = (timePoint5[0] - timePoint4[0]) * 1_000 + (timePoint5[1] - timePoint4[1]) / 1_000_000;
    //console.log(`Fetch to ${input} with access token took ${diff} ms, status ${responseFinal.status}`);
    return responseFinal
  }
}
