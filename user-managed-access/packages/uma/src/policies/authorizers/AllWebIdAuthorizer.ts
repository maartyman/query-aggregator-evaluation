import { getLoggerFor } from '@solid/community-server';
import { ANY_RESOURCE, ANY_SCOPE, Authorizer } from './Authorizer';
import { Permission } from '../../views/Permission';
import { Requirements } from '../../credentials/Requirements';
import { ClaimSet } from '../../credentials/ClaimSet';
import { WEBID } from '../../credentials/Claims';

/**
 * An Authorizer granting access for WebID's to resources in given namespaces.
 */
export class AllWebIdAuthorizer implements Authorizer {
  protected readonly logger = getLoggerFor(this);

  /** @inheritdoc */
  public async permissions(claims: ClaimSet, query?: Partial<Permission>[]): Promise<Permission[]> {
    this.logger.info(`Calculating permissions. ${JSON.stringify({ claims, query })}`);

    const webids = Array.isArray(claims[WEBID]) ? claims[WEBID] : [ claims[WEBID] ];

    if (!webids.some(webid => typeof webid === 'string')) return [];

    return (query ?? []).map(
      (permission): Permission => ({
        resource_id: permission.resource_id ?? ANY_RESOURCE,
        resource_scopes: permission.resource_scopes ?? [ ANY_SCOPE ]
      })
    );
  }

  /** @inheritdoc */
  public async credentials(permissions: Permission[], query?: Requirements): Promise<Requirements[]> {
    this.logger.info(`Calculating credentials. ${JSON.stringify({ permissions, query })}`);

    return [{
      [WEBID]: async () =>  true,
    }];
  }
}
