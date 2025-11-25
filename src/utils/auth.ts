import {createDpopHeader, generateDpopKeyPair, KeyPair} from "@inrupt/solid-client-authn-core";
import {EventEmitter} from "node:events";
import {fetch} from 'cross-fetch';
import {PodContext} from "../data-generator";
import fsp from 'node:fs/promises';
import path from 'node:path';
import {Logger} from './logger';

export class Auth {
  private readonly podContext: PodContext;
  private readonly cssBase: string;
  private dpopKey: KeyPair | undefined;
  private authString: string | undefined;
  private accessToken: string | undefined;
  private activeRequests = 0;
  private readonly maxConcurrentRequests = 30;
  private requestQueue: Array<() => void> = [];

  private readonly cacheEnabled: boolean;
  private readonly cacheFilePath: string;
  private cache: {
    asUriByOrigin: Record<string, string>;
    uma2ConfigByAsUri: Record<string, any>;
    publicResources: Record<string, true>;
  } = { asUriByOrigin: {}, uma2ConfigByAsUri: {}, publicResources: {} };

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
      if (parsed && typeof parsed === 'object') {
        this.cache.asUriByOrigin = parsed.asUriByOrigin ?? {};
        this.cache.uma2ConfigByAsUri = parsed.uma2ConfigByAsUri ?? {};
        this.cache.publicResources = parsed.publicResources ?? {};
        Logger.debug('Loaded cache from disk', this.cacheFilePath, {
          asUriByOrigin: Object.keys(this.cache.asUriByOrigin).length,
          uma2ConfigByAsUri: Object.keys(this.cache.uma2ConfigByAsUri).length,
          publicResources: Object.keys(this.cache.publicResources).length,
        });
      }
    } catch (e: any) {
      if (e?.code !== 'ENOENT') {
        Logger.warn(`Auth cache load failed: ${e?.message ?? String(e)}`);
      } else {
        Logger.debug('No existing cache file found at', this.cacheFilePath);
      }
    }
  }

  private async saveCache(): Promise<void> {
    if (!this.cacheEnabled) return;
    const tmp = `${this.cacheFilePath}.tmp`;
    const data = JSON.stringify(this.cache);
    await fsp.writeFile(tmp, data, 'utf8');
    await fsp.rename(tmp, this.cacheFilePath);
    Logger.debug('Saved cache to disk', this.cacheFilePath, {
      asUriByOrigin: Object.keys(this.cache.asUriByOrigin).length,
      uma2ConfigByAsUri: Object.keys(this.cache.uma2ConfigByAsUri).length,
      publicResources: Object.keys(this.cache.publicResources).length,
    });
  }

  private originFrom(input: string | URL | Request): string | undefined {
    try {
      const url = typeof input === 'string' ? new URL(input) : (input instanceof URL ? input : new URL((input as Request).url));
      return url.origin;
    } catch {
      return undefined;
    }
  }

  async init(): Promise<void> {
    await this.loadCache();
    this.dpopKey = await generateDpopKeyPair();

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

    const {id, secret} = await response.json();
    this.authString = `${encodeURIComponent(id)}:${encodeURIComponent(secret)}`;
  }

  async getAccessToken(): Promise<void> {
    if (!this.authString || !this.dpopKey) {
      throw new Error('Not initialized');
    }

    const response = await fetch(`${this.cssBase}/.oidc/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(this.authString).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
        dpop: await createDpopHeader(`${this.cssBase}/.oidc/token`, 'POST', this.dpopKey),
      },
      body: 'grant_type=client_credentials&scope=webid',
    });

    const accessTokenJson = await response.json();
    this.accessToken = accessTokenJson.access_token;
  }

  private async createClaim(tokenEndpoint: string, ticket: string) {
    if (!this.accessToken || !this.dpopKey) {
      throw new Error('Not initialized');
    }
    return {
      grant_type: 'urn:ietf:params:oauth:grant-type:uma-ticket',
      ticket,
      claim_token: JSON.stringify({
        Authorization: `DPop ${this.accessToken}`,
        DPoP: await createDpopHeader(tokenEndpoint, 'POST', this.dpopKey),
      }),
      claim_token_format: 'http://openid.net/specs/openid-connect-core-1_0.html#IDToken',
    };
  }

  // Direct UMA request without initial ticket using cached AS and UMA2 config
  private readonly readScope = 'urn:example:css:modes:read';
  private readonly createScope = 'urn:example:css:modes:create';
  private readonly writeScope = 'urn:example:css:modes:write';
  private readonly deleteScope = 'urn:example:css:modes:delete';

  private resolveScopesForMethod(method: string | undefined): string[] {
    switch ((method ?? 'GET').toUpperCase()) {
      case 'GET':
      case 'HEAD':
        return [this.readScope];
      case 'POST':
        return [this.createScope];
      case 'PUT':
      case 'PATCH':
        return [this.writeScope];
      case 'DELETE':
        return [this.deleteScope];
      default:
        return [this.readScope];
    }
  }

  private async requestTokenWithoutTicket(resourceUrl: string, asUri: string, method?: string): Promise<{ token_type: string; access_token: string } | undefined> {
    if (!this.accessToken || !this.dpopKey) return undefined;

    // Get UMA2 config (cache-aware)
    const tokenEndpoint = await this.getTokenEndpoint(asUri);
    if (!tokenEndpoint) return undefined;

    // Remove fragment from resourceUrl for UMA resource_id
    const sanitizedResourceId = resourceUrl.replace(/#.*/, '');
    if (sanitizedResourceId !== resourceUrl) {
      Logger.debug('Sanitized resource_id by removing fragment', { original: resourceUrl, sanitized: sanitizedResourceId });
    }

    const resource_scopes = this.resolveScopesForMethod(method);
    Logger.debug('Attempting direct UMA token request', { resourceUrl: sanitizedResourceId, asUri, tokenEndpoint, method: method ?? 'GET', resource_scopes });

    const body = {
      grant_type: 'urn:ietf:params:oauth:grant-type:uma-ticket',
      permissions: [{
        resource_id: sanitizedResourceId,
        resource_scopes,
      }],
      claim_token_format: 'http://openid.net/specs/openid-connect-core-1_0.html#IDToken',
      claim_token: JSON.stringify({
        Authorization: `DPop ${this.accessToken}`,
        DPoP: await createDpopHeader(tokenEndpoint, 'POST', this.dpopKey),
      }),
    };

    const res = await this.throttledFetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      Logger.debug('Direct UMA token request failed', tokenEndpoint, sanitizedResourceId, res.status);
      return undefined;
    }
    const json = await res.json();
    if (json?.access_token && json?.token_type) {
      Logger.debug('Direct UMA token request succeeded for resource', sanitizedResourceId);
      return { token_type: json.token_type, access_token: json.access_token };
    }
    Logger.debug('Direct UMA token response missing token fields for resource', sanitizedResourceId);
    return undefined;
  }

  private async getTokenEndpoint(asUri: string): Promise<string | undefined> {
    // Return from cache if available
    if (this.cacheEnabled && this.cache.uma2ConfigByAsUri[asUri]?.token_endpoint) {
      Logger.debug('UMA2 config cache hit for AS', asUri);
      return this.cache.uma2ConfigByAsUri[asUri].token_endpoint as string;
    }
    Logger.debug('UMA2 config cache miss for AS', asUri, 'fetching configuration');
    // Fetch and cache
    const uma2ConfigResponse = await this.throttledFetch(`${asUri}/.well-known/uma2-configuration`);
    if (!uma2ConfigResponse.ok) {
      Logger.debug('Failed to fetch UMA2 configuration for AS', asUri, uma2ConfigResponse.status);
      return undefined;
    }
    const uma2Config = await uma2ConfigResponse.json();
    if (this.cacheEnabled) {
      this.cache.uma2ConfigByAsUri[asUri] = uma2Config;
      await this.saveCache();
      Logger.debug('Cached UMA2 configuration for AS', asUri);
    }
    return uma2Config.token_endpoint as string;
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
    Logger.debug('Fetch start', { resourceUrl, cacheEnabled: this.cacheEnabled });

    // If resource is known to be public, fetch directly and skip UMA/cache steps
    if (this.cacheEnabled && this.cache.publicResources[resourceUrl]) {
      Logger.debug('Public resource cache HIT', resourceUrl);
      const response = await this.throttledFetch(input, init);
      if (response.status !== 401) {
        Logger.debug('Public resource confirmed (non-401)', resourceUrl, response.status);
        return response;
      }
      // Resource changed to protected; remove public marker and continue with normal flow
      Logger.debug('Public resource now protected, removing marker', resourceUrl);
      delete this.cache.publicResources[resourceUrl];
      await this.saveCache();
    }

    // Try direct UMA flow if cache is enabled and we know the AS for this origin
    if (this.cacheEnabled) {
      const origin = this.originFrom(input);
      const asUri = origin ? this.cache.asUriByOrigin[origin] : undefined;
      if (asUri) {
        Logger.debug('AS URI cache HIT for origin', origin, '->', asUri);
        try {
          const method = (init?.method ?? 'GET');
          const direct = await this.requestTokenWithoutTicket(resourceUrl, asUri, method);
          if (direct) {
            Logger.debug('Using direct UMA token for resource', resourceUrl);
            const directInit: RequestInit = init ? { ...init } : {};
            directInit.headers = { ...(init?.headers as any), Authorization: `${direct.token_type} ${direct.access_token}` };
            return await this.throttledFetch(input, directInit);
          }
          Logger.debug('Direct UMA token unavailable, falling back to ticket flow', resourceUrl);
        } catch (e: any) {
          Logger.debug('Direct UMA attempt threw, falling back', e?.message ?? String(e));
          // Fall back to normal flow
        }
      } else {
        Logger.debug('AS URI cache MISS for origin', origin);
      }
    }

    const response = await this.throttledFetch(input, init);
    if (response.status !== 401) {
      // Mark as public to skip UMA/cache next time
      if (this.cacheEnabled && !this.cache.publicResources[resourceUrl]) {
        this.cache.publicResources[resourceUrl] = true;
        await this.saveCache();
        Logger.debug('Marked resource as public', resourceUrl);
      } else {
        Logger.debug('Resource accessible without auth (not caching or already cached as public)', resourceUrl);
      }
      return response;
    }
    const wwwAuthenticateHeader = response.headers.get("WWW-Authenticate");
    if (!wwwAuthenticateHeader) {
      throw new Error(`Missing WWW-Authenticate header in 401 response ${resourceUrl}`);
    }
    const {as_uri, ticket} = Object.fromEntries(wwwAuthenticateHeader.replace(/^UMA /, '').split(', ').map(
      param => param.split('=').map(s => s.replace(/"/g, ''))
    ));
    Logger.debug('Received UMA challenge for resource', resourceUrl, 'AS:', as_uri);

    // Cache the AS URI by resource origin
    if (this.cacheEnabled) {
      const origin = this.originFrom(input);
      if (origin && this.cache.asUriByOrigin[origin] !== as_uri) {
        this.cache.asUriByOrigin[origin] = as_uri;
        await this.saveCache();
        Logger.debug('Cached AS URI for origin', origin, '->', as_uri);
      } else {
        Logger.debug('AS URI for origin already cached or origin undefined', origin);
      }
    }

    // Get UMA2 config (cache-aware)
    const tokenEndpoint = await this.getTokenEndpoint(as_uri);
    if (!tokenEndpoint) {
      Logger.debug('Token endpoint unavailable for AS', as_uri, 'returning original 401 response');
      return response;
    }

    const asRequestResponse = await this.throttledFetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(await this.createClaim(tokenEndpoint, ticket)),
    });
    if (!asRequestResponse.ok) {
      Logger.debug('AS token request failed with status', asRequestResponse.status);
      return asRequestResponse;
    }

    const asResponse: any = await asRequestResponse.json();
    if (!init) {
      init = {};
    }
    init.headers = {'Authorization': `${asResponse.token_type} ${asResponse.access_token}`};

    Logger.debug('Retrying resource with AS token', resourceUrl);
    return await this.throttledFetch(input, init);
  }

  async sse(input: string, abortController: AbortController): Promise<EventEmitter> {
    Logger.debug('SSE connection requested; cache bypassed intentionally', input);
    // Intentionally do not use cache for SSE
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

    const uma2ConfigResponse = await fetch(`${as_uri}/.well-known/uma2-configuration`);
    if (!uma2ConfigResponse.ok) {
      throw new Error('cannot get UMA2 configuration' + await uma2ConfigResponse.text());
    }
    const uma2Config = await uma2ConfigResponse.json();
    const tokenEndpoint = uma2Config.token_endpoint;

    const asRequestResponse = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(await this.createClaim(tokenEndpoint, ticket)),
    });
    if (!asRequestResponse.ok) {
      throw new Error('cannot get AS response' + await asRequestResponse.text());
    }

    const asResponse: any = await asRequestResponse.json();

    if (!serviceEndpoint) {
      throw new Error('Missing UMA service endpoint for SSE');
    }

    const serviceTokenResponse = await fetch(serviceEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        'Authorization': `${asResponse.token_type} ${asResponse.access_token}`,
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

