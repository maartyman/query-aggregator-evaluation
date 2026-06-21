import { HttpHandler, HttpHandlerInput } from '@solid/community-server';
import { AggregatorDiscoveryStore } from './AggregatorDiscoveryStore';

interface RegistrationBody {
  resources?: unknown;
  service?: unknown;
  aggregator?: unknown;
}

interface ValidRegistrationBody {
  resources: string[];
  service: string;
  aggregator?: string;
}

export class AggregatorDiscoveryHandler extends HttpHandler {
  public constructor(
    private readonly store: AggregatorDiscoveryStore,
  ) {
    super();
  }

  public async handle({ request, response }: HttpHandlerInput): Promise<void> {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, this.corsHeaders());
      response.end();
      return;
    }

    if (request.method !== 'POST') {
      response.writeHead(405, this.corsHeaders({ 'content-type': 'text/plain; charset=utf-8' }));
      response.end('Method not allowed');
      return;
    }

    let body: RegistrationBody;
    try {
      body = await this.readJson(request);
    } catch {
      response.writeHead(400, this.corsHeaders({ 'content-type': 'text/plain; charset=utf-8' }));
      response.end('Malformed JSON body');
      return;
    }
    if (!this.isValidRegistration(body)) {
      response.writeHead(400, this.corsHeaders({ 'content-type': 'text/plain; charset=utf-8' }));
      response.end('Expected JSON body with resources: string[] and service: string');
      return;
    }

    this.store.register({
      resources: body.resources,
      service: body.service,
      aggregator: body.aggregator,
    });

    response.writeHead(201, this.corsHeaders({ 'content-type': 'application/json' }));
    response.end(JSON.stringify({ status: 'registered' }));
  }

  private corsHeaders(headers: Record<string, string> = {}): Record<string, string> {
    return {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'Authorization, Content-Type',
      'access-control-expose-headers': '*',
      ...headers,
    };
  }

  private async readJson(request: HttpHandlerInput['request']): Promise<RegistrationBody> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as RegistrationBody;
  }

  private isValidRegistration(body: RegistrationBody): body is ValidRegistrationBody {
    return Array.isArray(body.resources) &&
      body.resources.length > 0 &&
      body.resources.every((resource): resource is string => this.isHttpUrl(resource)) &&
      typeof body.service === 'string' &&
      this.isHttpUrl(body.service) &&
      (body.aggregator === undefined || (typeof body.aggregator === 'string' && this.isHttpUrl(body.aggregator)));
  }

  private isHttpUrl(value: unknown): value is string {
    if (typeof value !== 'string') {
      return false;
    }
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }
}
