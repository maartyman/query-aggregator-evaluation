import {EventEmitter} from "node:events";
import {randomUUID} from "node:crypto";
import {fetch} from 'cross-fetch';
import {PodContext} from "../data-generator";
import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  Auth as TrustflowsAuth,
  Claim,
  ClaimResolutionContext,
  ClaimResolverDefinition,
  RequiredClaims,
  SuccessfulTokenResponse,
} from 'trustflows-client';
import {Logger} from './logger';
import {
  classifyHttpRequest,
  recordHttpRequest,
  trackResponseTriples,
  type HttpRequestKind
} from './http-metrics';

export interface ObservedHttpRequest {
  url: string;
  method: string;
  kind: HttpRequestKind;
  startedAtEpochMs: number;
  durationMs: number;
  status?: number;
  ok?: boolean;
  serverTiming?: string | null;
  error?: string;
}

export interface AuthFetchTiming {
  totalDurationMs: number;
  authDurationMs: number;
}

type TrustflowsClientModule = typeof import('trustflows-client');

let requestObserver: ((request: ObservedHttpRequest) => void) | undefined;
let trustflowsClientPromise: Promise<TrustflowsClientModule> | undefined;

const dynamicImport = new Function('specifier', 'return import(specifier)') as
  (specifier: string) => Promise<TrustflowsClientModule>;

function loadTrustflowsClient(): Promise<TrustflowsClientModule> {
  trustflowsClientPromise ??= dynamicImport('trustflows-client');
  return trustflowsClientPromise;
}

export class Auth {
  private readonly podContext: PodContext;
  private readonly cssBase: string;
  private accessToken: string | undefined;
  private trustflowsAuth: TrustflowsAuth | undefined;
  private activeRequests = 0;
  private readonly maxConcurrentRequests = 10;
  private requestQueue: Array<() => void> = [];
  private derivationClaimRequestCount = 0;
  private lastFetchTiming: AuthFetchTiming | undefined;

  constructor(podContext: PodContext, options?: { enableCache?: boolean; cacheFilePath?: string }) {
    this.podContext = podContext;
    this.cssBase = podContext.server.solidBaseUrl.replace(/\/$/, '');
    if (options?.enableCache || options?.cacheFilePath) {
      Logger.debug('Ignoring Auth token cache option; token caching is disabled for experiments');
    }
  }

  public static setRequestObserver(observer?: (request: ObservedHttpRequest) => void): void {
    requestObserver = observer;
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

  async init(): Promise<void> {
    const trustflowsClient = await loadTrustflowsClient();
    const auth = new trustflowsClient.Auth({
      fetch: this.throttledFetch.bind(this) as typeof globalThis.fetch,
      persistTokens: false,
      claimResolvers: [this.createCountingAccessTokenResolver(trustflowsClient)],
    });

    await auth.loginClientCredentials(this.podContext.webId, this.podContext.email, 'password');
    auth.webId = auth.webId ?? this.podContext.webId;
    this.trustflowsAuth = auth;
    this.accessToken = auth.accessToken;
  }

  private createCountingAccessTokenResolver(trustflowsClient: TrustflowsClientModule): ClaimResolverDefinition {
    return {
      id: 'query-aggregator-evaluation-access-token',
      match: [
        {claim_token_format: trustflowsClient.ACCESS_TOKEN_CLAIM_FORMAT},
        {claim_type: trustflowsClient.ACCESS_TOKEN_CLAIM_FORMAT},
        {claim_type: trustflowsClient.ACCESS_TOKEN_CLAIM_TYPE},
      ],
      priority: 100,
      groupBy: (required: RequiredClaims): string | undefined =>
        trustflowsClient.accessTokenIssuer(this.normalizeRequiredClaim(required)),
      resolve: async (
        required: RequiredClaims,
        auth: TrustflowsAuth,
        context?: ClaimResolutionContext
      ): Promise<Claim> => {
        this.derivationClaimRequestCount++;
        return trustflowsClient.resolveAccessTokenClaims([
          this.normalizeRequiredClaim(required)
        ], auth, context);
      },
      resolveGroup: async (
        requiredClaims: RequiredClaims[],
        auth: TrustflowsAuth,
        context?: ClaimResolutionContext
      ): Promise<Claim> => {
        this.derivationClaimRequestCount += requiredClaims.length;
        return trustflowsClient.resolveAccessTokenClaims(
          requiredClaims.map(required => this.normalizeRequiredClaim(required)),
          auth,
          context
        );
      },
    };
  }

  private normalizeRequiredClaim(required: RequiredClaims): RequiredClaims {
    const details = (required as any).details;
    return {
      ...required,
      issuer: required.issuer ?? details?.issuer,
      derivation_resource_id: required.derivation_resource_id ?? details?.resource_id,
      resource_scopes: required.resource_scopes ?? details?.resource_scopes,
    };
  }

  private async updatePatCredentialsIfSupported(): Promise<void> {
    let indexResponse = await this.throttledFetch(`${this.cssBase}/.account/`);
    if (!indexResponse.ok) {
      throw new Error('Account API request failed:' + await indexResponse.text());
    }
    let controls = (await indexResponse.json()).controls;
    if (!controls?.password?.login) {
      return;
    }

    let response = await this.throttledFetch(controls.password.login, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({email: this.podContext.email, password: 'password'}),
    });
    if (!response.ok) {
      throw new Error('Login failed:' + await response.text());
    }
    const {authorization} = await response.json();

    indexResponse = await this.throttledFetch(`${this.cssBase}/.account/`, {
      headers: {authorization: `CSS-Account-Token ${authorization}`},
    });
    if (!indexResponse.ok) {
      throw new Error('Login failed:' + await indexResponse.text());
    }
    controls = (await indexResponse.json()).controls;
    if (!controls.account?.pat) {
      return;
    }

    const umaCredentials = await this.createUmaClientCredentials();
    response = await this.throttledFetch(controls.account.pat, {
      method: 'POST',
      headers: {authorization: `CSS-Account-Token ${authorization}`, 'content-type': 'application/json'},
      body: JSON.stringify({
        id: umaCredentials.id,
        secret: umaCredentials.secret,
        issuer: this.podContext.server.umaBaseUrl,
      }),
    });
    if (!response.ok) {
      throw new Error('PAT update failed:' + await response.text());
    }
  }

  private async createUmaClientCredentials(): Promise<{ id: string; secret: string }> {
    const configResponse = await this.throttledFetch(`${this.podContext.server.umaBaseUrl}/.well-known/uma2-configuration`);
    if (!configResponse.ok) {
      throw new Error('UMA configuration request failed:' + await configResponse.text());
    }
    const config = await configResponse.json();
    const registrationEndpoint = config.registration_endpoint;
    if (!registrationEndpoint) {
      throw new Error('UMA configuration missing registration_endpoint');
    }

    const response = await this.throttledFetch(registrationEndpoint, {
      method: 'POST',
      headers: {
        authorization: `WebID ${encodeURIComponent(this.podContext.webId)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ client_uri: `${this.cssBase}/client/${randomUUID()}` }),
    });
    if (!response.ok) {
      throw new Error('UMA client registration failed:' + await response.text());
    }

    const credentials = await response.json();
    return {
      id: credentials.client_id,
      secret: credentials.client_secret,
    };
  }

  async getAccessToken(): Promise<void> {
    const auth = this.requireTrustflowsAuth();
    await auth.ensureValidToken();
    this.accessToken = auth.accessToken;
    if (!this.accessToken) {
      throw new Error('Access token not initialized');
    }
  }

  async createUmaPolicyForTargets(targets: string[], issuer: string = this.podContext.server.umaBaseUrl): Promise<void> {
    await this.getAccessToken();

    const policyId = `urn:query-aggregator-evaluation:runtime-policy:${randomUUID()}`;
    const permissionId = `urn:query-aggregator-evaluation:runtime-permission:${randomUUID()}`;
    const policy = [
      '@prefix odrl: <http://www.w3.org/ns/odrl/2/> .',
      '',
      `<${policyId}> a odrl:Agreement ;`,
      `  odrl:uid <${policyId}> ;`,
      `  odrl:permission <${permissionId}> .`,
      '',
      `<${permissionId}> a odrl:Permission ;`,
      '  odrl:action odrl:use ;',
      `  odrl:assignee <${this.podContext.webId}> ;`,
      `  odrl:assigner <${this.podContext.webId}> ;`,
      `  odrl:target ${targets.map(target => `<${target}>`).join(',\n    ')} .`,
      '',
    ].join('\n');

    const response = await this.throttledFetch(`${issuer}/policies`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        'content-type': 'text/turtle',
      },
      body: policy,
    });
    if (!response.ok && response.status !== 409) {
      throw new Error('UMA policy creation failed:' + await response.text());
    }
  }

  getDerivationClaimRequestCount(): number {
    return this.derivationClaimRequestCount;
  }

  consumeLastFetchTiming(): AuthFetchTiming | undefined {
    const timing = this.lastFetchTiming;
    this.lastFetchTiming = undefined;
    return timing;
  }

  private requireTrustflowsAuth(): TrustflowsAuth {
    if (!this.trustflowsAuth) {
      throw new Error('Not initialized');
    }
    return this.trustflowsAuth;
  }

  private async fetchUmaAccessToken(
    challenge: { as_uri: string; ticket: string }
  ): Promise<SuccessfulTokenResponse | undefined> {
    const auth = this.requireTrustflowsAuth();
    const trustflowsClient = await loadTrustflowsClient();
    try {
      const metadata = await trustflowsClient.discoverUmaConfiguration(challenge.as_uri, auth.getFetch());
      if (!metadata.token_endpoint) {
        Logger.debug('Token endpoint unavailable for AS', challenge.as_uri);
        return undefined;
      }
      return await trustflowsClient.fetchAccessToken(auth, metadata.token_endpoint, challenge.ticket);
    } catch (error) {
      Logger.debug('Failed to fetch UMA access token', error instanceof Error ? error.message : String(error));
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
    const requestKind = classifyHttpRequest(input);
    const method = init?.method || 'GET';
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    recordHttpRequest(requestKind);
    const started = process.hrtime.bigint();
    const startedAtEpochMs = Date.now();
    try {
      const response = await fetch(input, init);
      Auth.observeRequest(url, method, requestKind, started, startedAtEpochMs, response);
      trackResponseTriples(response, requestKind, method, url);
      return response;
    } catch (error) {
      Auth.observeRequest(url, method, requestKind, started, startedAtEpochMs, undefined, error);
      throw error;
    } finally {
      this.releaseRequestSlot();
    }
  }

  private async countedFetch(
    input: string | URL | Request,
    init?: RequestInit,
    requestKind?: HttpRequestKind
  ): Promise<Response> {
    const kind = requestKind ?? classifyHttpRequest(input);
    const method = init?.method || 'GET';
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    recordHttpRequest(kind);
    const started = process.hrtime.bigint();
    const startedAtEpochMs = Date.now();
    try {
      const response = await fetch(input, init);
      Auth.observeRequest(url, method, kind, started, startedAtEpochMs, response);
      trackResponseTriples(response, kind, method, url);
      return response;
    } catch (error) {
      Auth.observeRequest(url, method, kind, started, startedAtEpochMs, undefined, error);
      throw error;
    }
  }

  private static observeRequest(
    url: string,
    method: string,
    kind: HttpRequestKind,
    started: bigint,
    startedAtEpochMs: number,
    response?: Response,
    error?: unknown
  ): void {
    if (!requestObserver) {
      return;
    }

    requestObserver({
      url,
      method,
      kind,
      startedAtEpochMs,
      durationMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      status: response?.status,
      ok: response?.ok,
      serverTiming: response?.headers.get("server-timing"),
      error: error instanceof Error ? error.message : error === undefined ? undefined : String(error),
    });
  }

  async fetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const auth = this.requireTrustflowsAuth();
    const trustflowsClient = await loadTrustflowsClient();
    const resourceUrl = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : (input as Request).url);
    const method = init?.method || 'GET';
    const fetchStart = process.hrtime.bigint();
    let authDurationMs = 0;
    Logger.debug('Fetch start', { resourceUrl, method });
    auth.umaPermissionTokens.clear();

    const response = await this.throttledFetch(input, init);
    if (response.status !== 401) {
      Logger.debug('Resource accessible without auth, status', response.status);
      this.lastFetchTiming = {
        totalDurationMs: Number(process.hrtime.bigint() - fetchStart) / 1_000_000,
        authDurationMs,
      };
      return response;
    }

    const challenge = trustflowsClient.parseUmaAuthenticateHeader(response.headers);
    if (!challenge?.as_uri || !challenge.ticket) {
      Logger.debug('Missing or unsupported UMA challenge in 401 response', resourceUrl);
      this.lastFetchTiming = {
        totalDurationMs: Number(process.hrtime.bigint() - fetchStart) / 1_000_000,
        authDurationMs,
      };
      return response;
    }
    Logger.debug('Received UMA challenge for resource', resourceUrl, 'AS:', challenge.as_uri);

    const authStart = process.hrtime.bigint();
    const tokenResult = await this.fetchUmaAccessToken(challenge);
    authDurationMs = Number(process.hrtime.bigint() - authStart) / 1_000_000;
    if (!tokenResult) {
      this.lastFetchTiming = {
        totalDurationMs: Number(process.hrtime.bigint() - fetchStart) / 1_000_000,
        authDurationMs,
      };
      return response;
    }

    const headers = new Headers(init?.headers);
    headers.set('Authorization', `${tokenResult.token_type} ${tokenResult.access_token}`);

    Logger.debug('Retrying resource with new UMA token', resourceUrl);
    const retryResponse = await this.throttledFetch(input, {...init, headers});
    this.lastFetchTiming = {
      totalDurationMs: Number(process.hrtime.bigint() - fetchStart) / 1_000_000,
      authDurationMs,
    };
    return retryResponse;
  }

  async sse(input: string, abortController: AbortController): Promise<EventEmitter> {
    Logger.debug('SSE connection requested', input);
    const response = await this.countedFetch(input, {
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
      },
    }, 'resource');
    if (response.status !== 401) {
      throw new Error(`Did not receive 401 when trying to connect to SSE. status: ${response.status}, body: ${await response.text()}`);
    }

    const trustflowsClient = await loadTrustflowsClient();
    const challenge = trustflowsClient.parseUmaAuthenticateHeader(response.headers);
    if (!challenge?.as_uri || !challenge.ticket) {
      throw new Error(`Missing UMA challenge in 401 response ${input}`);
    }

    const serviceEndpoint = response.headers.get("Link")?.match(/<([^>]+)>;\s*rel="service-token-endpoint"/)?.[1];
    const tokenResult = await this.fetchUmaAccessToken(challenge);
    if (!tokenResult) {
      throw new Error('cannot get AS response');
    }

    if (!serviceEndpoint) {
      throw new Error('Missing UMA service endpoint for SSE');
    }

    const serviceTokenResponse = await this.countedFetch(serviceEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        'Authorization': `${tokenResult.token_type} ${tokenResult.access_token}`,
      },
      body: JSON.stringify({
        resource_url: input,
      }),
    }, 'authorizationToken');
    if (!serviceTokenResponse.ok) {
      throw new Error('cannot retrieve service token: ' + await serviceTokenResponse.text());
    }
    const serviceTokenJson = await serviceTokenResponse.json();

    const authenticatedResponse = await this.countedFetch(input, {
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Authorization': `Bearer ${serviceTokenJson.service_token}`,
      },
      signal: abortController.signal,
    }, 'resource');

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
