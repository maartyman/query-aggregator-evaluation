import {EventEmitter} from "node:events";
import {fetch} from 'cross-fetch';
import {PodContext} from "../data-generator";
import fsp from 'node:fs/promises';
import path from 'node:path';
import {Logger} from './logger';

export class Auth {
  private readonly podContext: PodContext;
  private readonly cssBase: string;
  private authString: string | undefined;
  private accessToken: string | undefined;
  private activeRequests = 0;
  private readonly maxConcurrentRequests = 30;
  private requestQueue: Array<() => void> = [];

  private readonly cacheEnabled: boolean;
  private readonly cacheFilePath: string;
  private umaPermissionTokens: Map<string, {
    token_type: string;
    access_token: string;
  }> = new Map();

  constructor(podContext: PodContext, options?: { enableCache?: boolean; cacheFilePath?: string }) {
    this.podContext = podContext;
    this.cssBase = podContext.server.solidBaseUrl.replace(/\/$/, '');
    this.cacheEnabled = options?.enableCache ?? false;
    this.cacheFilePath = options?.cacheFilePath ?? path.join(process.cwd(), '.cache');
    Logger.debug('Initialized Auth with cache:', this.cacheEnabled, 'cacheFilePath:', this.cacheFilePath);
  }

  public static async resetCache(cacheFilePath: string = '.cache'): Promise<void> {
    const filePath = path.join(process.cwd(), cacheFilePath);
    try {
      await fsp.rm(filePath);
      Logger.debug('Cache reset at', filePath);
    } catch {
      // Ignore
    }
  }

  private async loadCache(): Promise<void> {
    if (!this.cacheEnabled) return;
    try {
      const raw = await fsp.readFile(this.cacheFilePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.umaPermissionTokens) {
        for (const [key, entry] of Object.entries(parsed.umaPermissionTokens)) {
          const tokenEntry = entry as { token_type: string; access_token: string; expires_at?: number };
          if (tokenEntry && tokenEntry.access_token) {
            this.umaPermissionTokens.set(key, tokenEntry);
          }
        }
        Logger.debug('Loaded token cache from disk', this.cacheFilePath);
      }
    } catch (e: any) {
      if (e?.code !== 'ENOENT') {
        Logger.warn(`Token cache load failed: ${e?.message ?? String(e)}`);
      } else {
        Logger.debug('No existing cache file found at', this.cacheFilePath);
      }
    }
  }

  private async saveCache(): Promise<void> {
    if (!this.cacheEnabled) return;
    const tmp = `${this.cacheFilePath}.tmp`;
    const obj: Record<string, any> = {};
    for (const [key, entry] of this.umaPermissionTokens.entries()) {
      obj[key] = entry;
    }
    const data = JSON.stringify({ umaPermissionTokens: obj });
    await fsp.writeFile(tmp, data, 'utf8');
    await fsp.rename(tmp, this.cacheFilePath);
    Logger.debug('Saved token cache to disk', this.cacheFilePath, {
      tokenCount: this.umaPermissionTokens.size
    });
  }

  async init(): Promise<void> {
    await this.loadCache();

    let indexResponse = await fetch(`${this.cssBase}/.account/`);
    let controls = (await indexResponse.json()).controls;

    let response = await fetch(controls.password.login, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({email: this.podContext.email, password: 'password'}),
    });
    if (!response.ok) {
      throw new Error('Login failed:' + await response.text());
    }
    const {authorization} = await response.json();

    indexResponse = await fetch(`${this.cssBase}/.account/`, {
      headers: {authorization: `CSS-Account-Token ${authorization}`},
    });
    if (!indexResponse.ok) {
      throw new Error('Login failed:' + await indexResponse.text());
    }
    controls = (await indexResponse.json()).controls;

    response = await fetch(controls.account.clientCredentials, {
      method: 'POST',
      headers: {authorization: `CSS-Account-Token ${authorization}`, 'content-type': 'application/json'},
      body: JSON.stringify({name: 'my-token', webId: this.podContext.webId}),
    });

    if (!response.ok) {
      throw new Error('Client credentials request failed:' + await response.text());
    }

    const {id, secret} = await response.json();
    this.authString = `${encodeURIComponent(id)}:${encodeURIComponent(secret)}`;
  }

  async getAccessToken(): Promise<void> {
    if (!this.authString) {
      throw new Error('Not initialized');
    }

    const response = await fetch(`${this.cssBase}/.oidc/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(this.authString).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials&scope=webid',
    });

    const accessTokenJson = await response.json();
    this.accessToken = accessTokenJson.access_token;
  }

  private async fetchAccessToken(
    tokenEndpoint: string,
    request: string | Array<{ resource_id: string; resource_scopes: string[] }>,
    claims?: Array<{ claim_token: string; claim_token_format: string }>
  ): Promise<{
    token?: string;
    tokenType?: string;
    expiresIn?: number;
    error?: Error;
    claimsUsed?: Array<{ claim_token: string; claim_token_format: string }>;
  }> {
    let content: any;
    let claimsUsed = claims ? [...claims] : undefined;

    if (claims) {
      content = {
        grant_type: 'urn:ietf:params:oauth:grant-type:uma-ticket',
        claim_tokens: claims
      };
    } else {
      content = {
        grant_type: 'urn:ietf:params:oauth:grant-type:uma-ticket',
        claim_token: this.accessToken,
        claim_token_format: 'http://openid.net/specs/openid-connect-core-1_0.html#IDToken',
      };
      claimsUsed = [{
        claim_token: this.accessToken!,
        claim_token_format: 'http://openid.net/specs/openid-connect-core-1_0.html#IDToken'
      }];
    }

    if (typeof request === 'string') {
      content.ticket = request;
    } else {
      content.permissions = request;
    }

    const asRequestResponse = await this.throttledFetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(content)
    });

    if (asRequestResponse.status === 403) {
      let asRequestResponseJson: any;
      try {
        asRequestResponseJson = await asRequestResponse.json();
      } catch {
        return {
          error: new Error('403 without JSON body'),
          token: undefined,
          tokenType: undefined,
          expiresIn: undefined,
          claimsUsed
        };
      }

      try {
        claimsUsed = await this.gatherClaims(claimsUsed || [], asRequestResponseJson.required_claims);
      } catch (e: any) {
        return {
          error: e,
          token: undefined,
          tokenType: undefined,
          expiresIn: undefined,
          claimsUsed
        };
      }

      return this.fetchAccessToken(tokenEndpoint, asRequestResponseJson.ticket, claimsUsed);
    }

    if (asRequestResponse.status !== 200) {
      const text = await asRequestResponse.text();
      return {
        error: new Error(`Failed to fetch access token, error: ${text}`),
        token: undefined,
        tokenType: undefined,
        expiresIn: undefined,
        claimsUsed
      };
    }

    const asResponse = await asRequestResponse.json();
    return {
      token: asResponse.access_token,
      tokenType: asResponse.token_type,
      expiresIn: asResponse.expires_in,
      error: undefined,
      claimsUsed
    };
  }

  private async gatherClaims(
    claims: Array<{ claim_token: string; claim_token_format: string }>,
    requiredClaims: Array<any>
  ): Promise<Array<{ claim_token: string; claim_token_format: string }>> {
    for (const requiredClaim of requiredClaims) {
      switch (requiredClaim['claim_token_format']) {
        case 'urn:ietf:params:oauth:token-type:access_token':
          const tokenEndpoint = requiredClaim.details.issuer + '/token';
          const { token, error } = await this.fetchAccessToken(
            tokenEndpoint,
            [{
              resource_id: requiredClaim.details.resource_id,
              resource_scopes: requiredClaim.details.resource_scopes
            }]
          );
          if (error) throw error;
          claims.push({
            claim_token: token!,
            claim_token_format: 'urn:ietf:params:oauth:token-type:access_token'
          });
          break;
        default:
          throw new Error(`Unsupported claim token format: ${requiredClaim['claim_token_format']}`);
      }
    }
    return claims;
  }

  // Token cache helpers
  private buildUmaTokenKey(resourceUrl: string, method: string = 'GET'): string {
    return `${method.toUpperCase()} ${resourceUrl}`;
  }

  private getStoredUmaToken(resourceUrl: string, method: string = 'GET') {
    const key = this.buildUmaTokenKey(resourceUrl, method);
    const entry = this.umaPermissionTokens.get(key);
    if (!entry) return undefined;
    return entry;
  }

  private async storeUmaToken(resourceUrl: string, method: string, token: { token_type: string; access_token: string; expires_in?: number }) {
    const key = this.buildUmaTokenKey(resourceUrl, method);
    this.umaPermissionTokens.set(key, {
      token_type: token.token_type,
      access_token: token.access_token
    });
    await this.saveCache();
  }

  private async getTokenEndpoint(asUri: string): Promise<string | undefined> {
    const uma2ConfigResponse = await this.throttledFetch(`${asUri}/.well-known/uma2-configuration`);
    if (!uma2ConfigResponse.ok) {
      Logger.debug('Failed to fetch UMA2 configuration for AS', asUri, uma2ConfigResponse.status);
      return undefined;
    }
    try {
      const uma2Config = await uma2ConfigResponse.json();
      return uma2Config.token_endpoint as string;
    } catch {
      return undefined;
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
    const resourceUrl = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : (input as Request).url);
    const method = init?.method || 'GET';
    Logger.debug('Fetch start', { resourceUrl, method });

    // Check for cached UMA token
    const existingUmaToken = this.getStoredUmaToken(resourceUrl, method);

    if (existingUmaToken) {
      const cachedInit: RequestInit = init ? { ...init } : {};
      cachedInit.headers = {
        ...(init?.headers as any),
        Authorization: `${existingUmaToken.token_type} ${existingUmaToken.access_token}`
      };
      Logger.debug('Using cached UMA token for resource', resourceUrl);
      const response = await this.throttledFetch(input, cachedInit);
      if (response.status !== 401) {
        Logger.debug('Cached token worked, status', response.status);
        return response;
      }
      // Cached token failed, remove it and retry
      Logger.debug('Cached token failed with 401, removing from cache', resourceUrl);
      this.umaPermissionTokens.delete(this.buildUmaTokenKey(resourceUrl, method));
    }

    // Try without token or retry without cached token
    const response = await this.throttledFetch(input, init);
    if (response.status !== 401) {
      Logger.debug('Resource accessible without auth, status', response.status);
      return response;
    }

    // Handle UMA challenge
    const wwwAuthenticateHeader = response.headers.get("WWW-Authenticate");
    if (!wwwAuthenticateHeader) {
      Logger.debug('Missing WWW-Authenticate header in 401 response', resourceUrl);
      return response;
    }
    const {as_uri, ticket} = Object.fromEntries(wwwAuthenticateHeader.replace(/^UMA /, '').split(', ').map(
      param => param.split('=').map(s => s.replace(/"/g, ''))
    ));
    Logger.debug('Received UMA challenge for resource', resourceUrl, 'AS:', as_uri);

    // Get token endpoint
    const tokenEndpoint = await this.getTokenEndpoint(as_uri);
    if (!tokenEndpoint) {
      Logger.debug('Token endpoint unavailable for AS', as_uri, 'returning original 401 response');
      return response;
    }

    // Fetch access token with claim gathering
    const { token, tokenType, expiresIn, error } = await this.fetchAccessToken(tokenEndpoint, ticket);
    if (error || !token || !tokenType) {
      Logger.debug('Failed to fetch access token', error?.message);
      return response;
    }

    // Store token in cache
    this.storeUmaToken(resourceUrl, method, {
      token_type: tokenType,
      access_token: token,
      expires_in: expiresIn
    });

    // Retry with new token
    const finalInit: RequestInit = init ? { ...init } : {};
    finalInit.headers = {
      ...(init?.headers as any),
      Authorization: `${tokenType} ${token}`
    };

    Logger.debug('Retrying resource with new UMA token', resourceUrl);
    return await this.throttledFetch(input, finalInit);
  }

  async sse(input: string, abortController: AbortController): Promise<EventEmitter> {
    Logger.debug('SSE connection requested', input);
    const response = await fetch(input, {
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
      },
    });
    if (response.status !== 401) {
      throw new Error(`Did not receive 401 when trying to connect to SSE. status: ${response.status}, body: ${await response.text()}`);
    }
    const wwwAuthenticateHeader = response.headers.get("WWW-Authenticate");
    if (!wwwAuthenticateHeader) {
      throw new Error(`Missing WWW-Authenticate header in 401 response ${input}`);
    }
    const {as_uri, ticket} = Object.fromEntries(wwwAuthenticateHeader.replace(/^UMA /, '').split(', ').map(
      param => param.split('=') .map(s => s.replace(/"/g, ''))
    ));

    const serviceEndpoint = response.headers.get("Link")?.match(/<([^>]+)>;\s*rel="service-token-endpoint"/)?.[1];

    const tokenEndpoint = await this.getTokenEndpoint(as_uri);
    if (!tokenEndpoint) {
      throw new Error('cannot get UMA2 token endpoint');
    }

    const { token, tokenType, error } = await this.fetchAccessToken(tokenEndpoint, ticket);
    if (error || !token || !tokenType) {
      throw new Error('cannot get AS response: ' + (error?.message ?? 'Unknown error'));
    }

    if (!serviceEndpoint) {
      throw new Error('Missing UMA service endpoint for SSE');
    }

    const serviceTokenResponse = await fetch(serviceEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        'Authorization': `${tokenType} ${token}`,
      },
      body: JSON.stringify({
        resource_url: input,
      }),
    });
    if (!serviceTokenResponse.ok) {
      throw new Error('cannot retrieve service token: ' + await serviceTokenResponse.text());
    }
    const serviceTokenJson = await serviceTokenResponse.json();

    const authenticatedResponse = await fetch(input, {
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Authorization': `Bearer ${serviceTokenJson.service_token}`,
      },
      signal: abortController.signal,
    });

    if (!authenticatedResponse.ok || !authenticatedResponse.body) {
      throw new Error(`cannot connect to SSE (status: ${authenticatedResponse.status}):` + await authenticatedResponse.text());
    }

    const emitter = new EventEmitter();
    let buffer = '';
    let currentEventType = '';
    const nodeStream = authenticatedResponse.body as any;
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
          emitter.emit('message', {
            eventType: currentEventType,
            data: JSON.parse(data),
          });
        }
      }
    });
    nodeStream.on('end', () => emitter.emit('end'));
    nodeStream.on('error', (e: Error) => emitter.emit('error', e));

    return emitter;
  }
}

