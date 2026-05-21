import { Parser } from 'n3';

export type HttpRequestKind = 'resource' | 'authorizationToken';

export interface HttpMetricsSnapshot {
  totalHttpRequests: number;
  resourceRequests: number;
  authorizationTokenRequests: number;
  numberOfTriples: number;
}

let generation = 0;
let resourceRequests = 0;
let authorizationTokenRequests = 0;
let numberOfTriples = 0;
let pendingTripleCounts: Promise<void>[] = [];

export function resetHttpMetrics(): void {
  generation++;
  resourceRequests = 0;
  authorizationTokenRequests = 0;
  numberOfTriples = 0;
  pendingTripleCounts = [];
}

export function recordHttpRequest(kind: HttpRequestKind): void {
  if (kind === 'authorizationToken') {
    authorizationTokenRequests++;
  } else {
    resourceRequests++;
  }
}

export function classifyHttpRequest(input: string | URL | Request): HttpRequestKind {
  const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);

  if (
    url.includes('/.account/') ||
    url.includes('/.oidc/token') ||
    url.includes('/.well-known/uma2-configuration') ||
    url.endsWith('/token') ||
    url.includes('/token?') ||
    url.includes('service-token')
  ) {
    return 'authorizationToken';
  }

  return 'resource';
}

export function trackResponseTriples(
  response: Response,
  requestKind: HttpRequestKind,
  method: string = 'GET',
  url?: string
): void {
  if (requestKind !== 'resource' || method.toUpperCase() !== 'GET' || !response.ok) {
    return;
  }

  const contentType = response.headers.get('content-type') || '';
  if (
    contentType.includes('application/json') ||
    contentType.includes('application/sparql-results+json') ||
    contentType.includes('text/event-stream')
  ) {
    return;
  }

  const trackedGeneration = generation;
  const tripleCountPromise = response.clone().text()
    .then(body => {
      if (trackedGeneration !== generation) {
        return;
      }

      const rdfBody = extractRdfBody(body, contentType);
      if (!rdfBody) {
        return;
      }

      try {
        const parser = new Parser({ format: 'text/turtle', baseIRI: url });
        numberOfTriples += parser.parse(rdfBody).length;
      } catch {
        // Not every successful resource response is Turtle; ignore bodies we cannot parse.
      }
    })
    .catch(() => {
      // Metrics must not affect experiment execution.
    });

  pendingTripleCounts.push(tripleCountPromise);
}

export async function getHttpMetricsSnapshot(): Promise<HttpMetricsSnapshot> {
  await Promise.allSettled(pendingTripleCounts);

  return {
    totalHttpRequests: resourceRequests + authorizationTokenRequests,
    resourceRequests,
    authorizationTokenRequests,
    numberOfTriples
  };
}

function extractRdfBody(body: string, contentType: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) {
    return null;
  }

  if (contentType.includes('text/html') || trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) {
    const matches = [...body.matchAll(/<script[^>]*type=["']text\/turtle["'][^>]*>([\s\S]*?)<\/script>/gi)];
    if (matches.length === 0) {
      return null;
    }
    return matches.map(match => match[1]).join('\n\n');
  }

  return body;
}
