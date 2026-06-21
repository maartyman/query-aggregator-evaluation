export interface AggregatorDiscoveryRegistration {
  resources: string[];
  service: string;
  aggregator?: string;
}

export class AggregatorDiscoveryStore {
  private readonly servicesByResource = new Map<string, Set<string>>();

  public register(input: AggregatorDiscoveryRegistration): void {
    for (const resource of input.resources) {
      const normalizedResource = this.normalizeResource(resource);
      let services = this.servicesByResource.get(normalizedResource);
      if (!services) {
        services = new Set<string>();
        this.servicesByResource.set(normalizedResource, services);
      }
      services.add(input.service);
    }
  }

  public getServices(resource: string): string[] {
    const normalizedResource = this.tryNormalizeResource(resource);
    if (!normalizedResource) {
      return [];
    }
    const services = this.servicesByResource.get(normalizedResource);
    return services ? [ ...services ].sort() : [];
  }

  private tryNormalizeResource(resource: string): string | undefined {
    try {
      return this.normalizeResource(resource);
    } catch {
      return;
    }
  }

  private normalizeResource(resource: string): string {
    const url = new URL(resource);
    url.hash = '';
    return url.href;
  }
}
