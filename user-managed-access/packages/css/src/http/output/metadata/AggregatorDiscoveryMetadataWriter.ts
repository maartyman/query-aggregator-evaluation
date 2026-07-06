import { addHeader, type HttpResponse, MetadataWriter, type RepresentationMetadata } from '@solid/community-server';
import { AggregatorDiscoveryStore } from '../../../aggregator/AggregatorDiscoveryStore';

const AVAILABLE_SERVICE_REL = 'https://w3id.org/aggregator#availableService';

export class AggregatorDiscoveryMetadataWriter extends MetadataWriter {
  public constructor(
    private readonly store: AggregatorDiscoveryStore,
  ) {
    super();
  }

  public async handle(input: {
    response: HttpResponse;
    metadata: RepresentationMetadata;
  }): Promise<void> {
    const services = this.store.getServices(input.metadata.identifier.value);
    if (services.length === 0) {
      return;
    }

    addHeader(
      input.response,
      'Link',
      services.map(service => `<${service}>; rel="${AVAILABLE_SERVICE_REL}"`),
    );
  }
}
