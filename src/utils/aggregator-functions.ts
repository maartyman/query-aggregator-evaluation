import {Auth} from "./auth";
import {ExperimentResult, type PhaseTiming} from "./result-builder";
const aggregatorUrl = "http://localhost:5000/";
const aggregatorUmaIssuer = "http://localhost:4000/uma";
const availableServiceRel = "https://w3id.org/aggregator#availableService";
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type FetchClient = Auth | FetchLike;
export interface TimedAggregatorResult {
  json: any;
  phaseTimings: PhaseTiming[];
  metrics?: Record<string, any>;
}

function getFetch(client: FetchClient): FetchLike {
  return typeof client === "function" ? client : client.fetch.bind(client);
}

function appendPhase(
  phaseTimings: PhaseTiming[],
  cumulativeMs: number,
  label: string,
  durationMs: number
): number {
  const nextCumulativeMs = cumulativeMs + durationMs;
  phaseTimings.push({
    label,
    durationMs,
    cumulativeMs: nextCumulativeMs,
  });
  return nextCumulativeMs;
}

async function fetchAggregatorJsonWithTimings(
  client: FetchClient,
  outputUrl: string,
  phaseTimings: PhaseTiming[],
  cumulativeMs: number,
  errorMessage: (response: Response, body: string) => string
): Promise<{ json: any; cumulativeMs: number }> {
  const fetchService = getFetch(client);
  const outputFetchStart = process.hrtime();
  const response = await fetchService(outputUrl, {
    method: "GET",
    headers: {
      "Accept": "application/sparql-results+json"
    }
  });
  const outputFetchMs = ExperimentResult.millisecondsSince(outputFetchStart);
  const authTiming = client instanceof Auth ? client.consumeLastFetchTiming() : undefined;
  const authMs = authTiming?.authDurationMs ?? 0;
  const fetchWithoutAuthMs = Math.max(0, outputFetchMs - authMs);

  cumulativeMs = appendPhase(phaseTimings, cumulativeMs, "Fetch JSON result response", fetchWithoutAuthMs);
  cumulativeMs = appendPhase(phaseTimings, cumulativeMs, "Auth", authMs);

  if (!response.ok) {
    throw new Error(errorMessage(response, await response.text()));
  }

  const bodyStart = process.hrtime();
  const json = await response.json();
  const bodyMs = ExperimentResult.millisecondsSince(bodyStart);
  cumulativeMs = appendPhase(phaseTimings, cumulativeMs, "Receive JSON result body", bodyMs);

  return { json, cumulativeMs };
}

export async function createAggregatorService(auth: Auth, FnoDescription: string): Promise<string> {
  const response = await auth.fetch(`${aggregatorUrl}config/actors`, {
    method: "POST",
    headers: {
      "content-type": "text/turtle"
    },
    body: FnoDescription,
  });
  if (!response.ok) {
    throw new Error(`Failed to configure aggregator: ${await response.text()}`);
  }
  const id = (await response.json()).id;
  await auth.createUmaPolicyForTargets([
    `${aggregatorUrl}${id}`,
    `${aggregatorUrl}${id}/`,
    `${aggregatorUrl}config/actors/${id}`,
  ], aggregatorUmaIssuer);
  return id;
}

export async function registerAggregatorServiceDescription(auth: Auth, FnoDescription: string): Promise<string> {
  const response = await auth.fetch(`${aggregatorUrl}config/actors?descriptionOnly=true`, {
    method: "POST",
    headers: {
      "content-type": "text/turtle"
    },
    body: FnoDescription,
  });
  if (!response.ok) {
    throw new Error(`Failed to register aggregator service description: ${await response.text()}`);
  }
  return (await response.json()).id;
}

export async function getAggregatorService(client: FetchClient, serviceId: string): Promise<any> {
  return (await getAggregatorServiceWithTimings(client, serviceId)).json;
}

export async function getAggregatorServiceWithTimings(client: FetchClient, serviceId: string): Promise<TimedAggregatorResult> {
  const phaseTimings: PhaseTiming[] = [];
  const { json } = await fetchAggregatorJsonWithTimings(
    client,
    `${aggregatorUrl}${serviceId}/`,
    phaseTimings,
    0,
    (response, body) => `Failed to get aggregator. status: ${response.status}, body: ${body}`
  );
  return { json, phaseTimings };
}

export async function getDiscoveredAggregatorService(
  client: FetchClient,
  sources: string[],
  queryString: string
): Promise<any> {
  return (await getDiscoveredAggregatorServiceWithTimings(client, sources, queryString)).json;
}

export async function getDiscoveredAggregatorServiceWithTimings(
  client: FetchClient,
  sources: string[],
  queryString: string
): Promise<TimedAggregatorResult> {
  const phaseTimings: PhaseTiming[] = [];
  let cumulativeMs = 0;
  const discoveryStart = process.hrtime();
  const service = await discoverAggregatorService(client, sources, queryString);
  const discoveryMs = ExperimentResult.millisecondsSince(discoveryStart);
  cumulativeMs = appendPhase(phaseTimings, cumulativeMs, "Discover the correct service", discoveryMs);
  const { json } = await fetchAggregatorJsonWithTimings(
    client,
    service.outputUrl,
    phaseTimings,
    cumulativeMs,
    (response, body) => `Failed to get discovered aggregator service. service: ${service.descriptionUrl}, status: ${response.status}, body: ${body}`
  );
  return {
    json,
    phaseTimings,
    metrics: {
      serviceAlternatives: service.serviceAlternatives,
    },
  };
}

export async function discoverAggregatorService(
  client: FetchClient,
  sources: string[],
  queryString: string
): Promise<{ descriptionUrl: string; outputUrl: string; serviceAlternatives: number }> {
  const discovery = await discoverCandidateServiceDescriptions(client, sources, queryString);
  if (discovery.candidateUrls.length === 1) {
    return {
      descriptionUrl: discovery.candidateUrls[0],
      outputUrl: serviceDescriptionToOutputUrl(discovery.candidateUrls[0]),
      serviceAlternatives: discovery.serviceAlternatives,
    };
  }

  throw new Error(
    `No discovered aggregator service matched query. candidates: ${discovery.candidateUrls.length}`
  );
}

async function discoverCandidateServiceDescriptions(
  client: FetchClient,
  sources: string[],
  queryString: string
): Promise<{ candidateUrls: string[]; serviceAlternatives: number }> {
  const fetchService = getFetch(client);
  const sourceUrls = orderDiscoverySources(Array.from(new Set(sources.map(stripFragment))));
  const normalizedQuery = normalizeQuery(queryString);
  let candidates: Set<string> | undefined;
  const descriptionFetches = new Map<string, {
    controller: AbortController;
    promise: Promise<string | undefined>;
  }>();

  for (let index = 0; index < sourceUrls.length; index++) {
    const response = await fetchDiscoveryResource(fetchService, sourceUrls[index]);
    if (!response.ok) {
      continue;
    }
    const sourceServices = new Set(extractAvailableServiceLinks(response.headers));
    await drainResponse(response);

    if (sourceServices.size === 0) {
      continue;
    }

    candidates = candidates ?
      intersectSets(candidates, sourceServices) :
      sourceServices;

    pruneDescriptionFetches(descriptionFetches, candidates);
    startDescriptionFetches(fetchService, candidates, descriptionFetches);

    const shouldTryMatch = candidates.size <= 8 || index === sourceUrls.length - 1;
    if (shouldTryMatch) {
      const matched = await findMatchingDescription(candidates, descriptionFetches, normalizedQuery);
      if (matched) {
        abortUnusedDescriptionFetches(descriptionFetches, new Set([ matched ]));
        return {
          candidateUrls: [ matched ],
          serviceAlternatives: candidates.size,
        };
      }
    }
  }

  return {
    candidateUrls: [],
    serviceAlternatives: candidates?.size ?? 0,
  };
}

function startDescriptionFetches(
  fetchService: FetchLike,
  candidates: Set<string>,
  descriptionFetches: Map<string, { controller: AbortController; promise: Promise<string | undefined> }>
): void {
  for (const descriptionUrl of candidates) {
    if (descriptionFetches.has(descriptionUrl)) {
      continue;
    }

    const controller = new AbortController();
    const promise = fetchServiceDescription(fetchService, descriptionUrl, controller.signal)
      .catch(() => undefined);
    descriptionFetches.set(descriptionUrl, { controller, promise });
  }
}

function pruneDescriptionFetches(
  descriptionFetches: Map<string, { controller: AbortController; promise: Promise<string | undefined> }>,
  candidates: Set<string>
): void {
  for (const [descriptionUrl, fetchState] of descriptionFetches) {
    if (!candidates.has(descriptionUrl)) {
      fetchState.controller.abort();
      descriptionFetches.delete(descriptionUrl);
    }
  }
}

function abortUnusedDescriptionFetches(
  descriptionFetches: Map<string, { controller: AbortController; promise: Promise<string | undefined> }>,
  keep: Set<string>
): void {
  for (const [descriptionUrl, fetchState] of descriptionFetches) {
    if (!keep.has(descriptionUrl)) {
      fetchState.controller.abort();
    }
  }
}

async function findMatchingDescription(
  candidates: Set<string>,
  descriptionFetches: Map<string, { controller: AbortController; promise: Promise<string | undefined> }>,
  normalizedQuery: string
): Promise<string | undefined> {
  const pending = new Map<string, Promise<{ descriptionUrl: string; description: string | undefined }>>();
  for (const descriptionUrl of Array.from(candidates).sort()) {
    const fetchState = descriptionFetches.get(descriptionUrl);
    if (!fetchState) {
      continue;
    }
    pending.set(descriptionUrl, fetchState.promise.then(description => ({ descriptionUrl, description })));
  }

  while (pending.size > 0) {
    const { descriptionUrl, description } = await Promise.race(pending.values());
    pending.delete(descriptionUrl);
    if (description && serviceDescriptionContainsQuery(description, normalizedQuery)) {
      return descriptionUrl;
    }
  }

  return undefined;
}

async function fetchDiscoveryResource(fetchService: FetchLike, source: string): Promise<Response> {
  const isContainer = source.endsWith("/");
  return await fetchService(source, {
    method: isContainer ? "GET" : "HEAD",
    headers: isContainer ? { "Accept": "text/turtle" } : undefined
  });
}

async function fetchServiceDescription(fetchService: FetchLike, serviceUrl: string, signal?: AbortSignal): Promise<string> {
  const response = await fetchService(serviceUrl, {
    method: "GET",
    headers: {
      "Accept": "application/json,text/turtle,*/*"
    },
    signal
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch discovered service description ${serviceUrl}: ${response.status} ${await response.text()}`);
  }
  return await response.text();
}

function extractAvailableServiceLinks(headers: Headers): string[] {
  return parseLinkHeader(headers.get("Link"))
    .filter(link => link.rel === availableServiceRel)
    .map(link => link.href);
}

function parseLinkHeader(value: string | null): Array<{ href: string; rel?: string }> {
  if (!value) {
    return [];
  }

  return splitLinkHeader(value).flatMap(entry => {
    const hrefMatch = entry.match(/^\s*<([^>]+)>/);
    if (!hrefMatch) {
      return [];
    }
    const relMatch = entry.match(/(?:^|;)\s*rel="([^"]+)"/);
    return [{
      href: hrefMatch[1],
      rel: relMatch?.[1]
    }];
  });
}

function splitLinkHeader(value: string): string[] {
  const entries: string[] = [];
  let current = "";
  let inAngle = false;
  let inQuote = false;

  for (const char of value) {
    if (char === "<" && !inQuote) {
      inAngle = true;
    } else if (char === ">" && !inQuote) {
      inAngle = false;
    } else if (char === '"' && !inAngle) {
      inQuote = !inQuote;
    }

    if (char === "," && !inAngle && !inQuote) {
      entries.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    entries.push(current.trim());
  }

  return entries;
}

function serviceDescriptionToOutputUrl(descriptionUrl: string): string {
  const parsed = new URL(descriptionUrl);
  const actorMatch = parsed.pathname.match(/^\/config\/actors\/([^/]+)$/);
  if (actorMatch) {
    return `${parsed.origin}/${actorMatch[1]}/`;
  }

  if (parsed.pathname.endsWith("/output")) {
    return descriptionUrl;
  }
  if (parsed.pathname.includes("/services/")) {
    return descriptionUrl.replace(/\/?$/, "/output");
  }

  return descriptionUrl;
}

function normalizeQuery(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function serviceDescriptionContainsQuery(description: string, normalizedQuery: string): boolean {
  const comparableDescription = normalizeQuery(extractPipelineDescription(description));
  return comparableDescription.length >= normalizedQuery.length &&
    comparableDescription.includes(normalizedQuery);
}

function extractPipelineDescription(description: string): string {
  try {
    const parsed = JSON.parse(description);
    if (typeof parsed?.pipelineDescription === "string") {
      return parsed.pipelineDescription;
    }
  } catch {
    // Non-JSON service descriptions are matched as-is.
  }

  return description;
}

function orderDiscoverySources(sources: string[]): string[] {
  return sources.sort((left, right) => discoverySourcePriority(left) - discoverySourcePriority(right));
}

function discoverySourcePriority(source: string): number {
  try {
    const url = new URL(source);
    let priority = 0;
    if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      priority += 100;
    }
    if (source.endsWith("/")) {
      priority += 10;
    }
    if (url.hostname.includes("github.io")) {
      priority += 50;
    }
    return priority;
  } catch {
    return 1000;
  }
}

function intersectSets(left: Set<string>, right: Set<string>): Set<string> {
  const result = new Set<string>();
  const [smallest, largest] = left.size <= right.size ? [left, right] : [right, left];
  for (const value of smallest) {
    if (largest.has(value)) {
      result.add(value);
    }
  }
  return result;
}

function stripFragment(source: string): string {
  try {
    const url = new URL(source);
    url.hash = "";
    return url.href;
  } catch {
    return source;
  }
}

async function drainResponse(response: Response): Promise<void> {
  if (!response.body || response.bodyUsed) {
    return;
  }
  try {
    await response.arrayBuffer();
  } catch {
    // Discovery only needs headers; ignore body read failures.
  }
}

export async function waitForAggregatorService(auth: Auth, serviceId: string, expectedBindings: number | null = 0): Promise<void> {
  const timeoutMs = expectedBindings === null
    ? 120_000
    : Math.max(120_000, expectedBindings * 5_000);
  const pollMs = 500;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const result = await getAggregatorService(auth, serviceId);
      const bindings = result?.results?.bindings;
      if (Array.isArray(bindings) && (expectedBindings === null || bindings.length >= expectedBindings)) {
        return;
      }
      lastError = new Error(
        `Aggregator service ${serviceId} returned ${Array.isArray(bindings) ? bindings.length : "no"} binding(s).` +
        (expectedBindings === null ? "" : ` Expected at least ${expectedBindings}.`)
      );
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }

  throw new Error(`Aggregator service ${serviceId} did not become readable within ${timeoutMs}ms: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}
