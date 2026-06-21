import {getLoggerFor, KeyValueStorage} from '@solid/community-server';
import { Authorizer } from './Authorizer';
import { Permission } from '../../views/Permission';
import { ClaimSet } from '../../credentials/ClaimSet';
import { Requirements } from '../../credentials/Requirements';
import {ResourceDescription} from "../../views/ResourceDescription";
import {UPSTREAMPERMISSION} from "../../credentials/Claims";

/**
 * Mock authorizer granting all specified access modes
 * to any client.
 */
export class DerivedFromAuthorizer implements Authorizer {
  protected readonly logger = getLoggerFor(this);

  /**
   * Creates a new DerivedFromAuthorizer.
   *
   * @param authorizer - the authorizer to delegate to.
   * @param resourceStore - The key/value store containing the resource registrations.
   */
  constructor(
    protected authorizer: Authorizer,
    protected resourceStore: KeyValueStorage<string, ResourceDescription>,
  ) {}

  /** @inheritdoc */
  public async permissions(claims: ClaimSet, query?: Partial<Permission>[]): Promise<Permission[]> {
    return await this.authorizer.permissions(claims, query);
  }

  /** @inheritdoc */
  public async credentials(permissions: Permission[]): Promise<Requirements[]> {
    const otherRequirements = await this.authorizer.credentials(permissions);

    this.logger.info(`DerivedFromAuthorizer: computing credentials for ${permissions.length} permission(s).`);

    for (let i = 0; permissions.length > i; i++) {
      const resourceId = permissions[i].resource_id!;
      this.logger.debug(`Checking upstream derivation for resource '${resourceId}'.`);
      const resource = await this.resourceStore.get(resourceId);
      if (resource && resource.resource_relations && (<any>resource.resource_relations)["prov:wasDerivedFrom"]) {
        const relations = (<any>resource.resource_relations);
        const upstream = Array.isArray(relations['prov:wasDerivedFrom'])
          ? relations['prov:wasDerivedFrom'] as {issuer: string, derivation_resource_id: string}[]
          : [relations['prov:wasDerivedFrom'] as {issuer: string, derivation_resource_id: string}];
        this.logger.info(`Resource '${resourceId}' has ${upstream.length} upstream derivation relation(s).`);
        for (const {issuer, derivation_resource_id } of upstream) {
          this.logger.debug(`Adding upstream requirement`);
          this.logger.debug(` issuer='${issuer}', derivation_resource_id='${derivation_resource_id}'.`);
          otherRequirements[i][UPSTREAMPERMISSION] =
            (
              async (upstreamPermission: { issuer: string, derivation_resource_id: string }) =>
                upstreamPermission.issuer === issuer &&
                upstreamPermission.derivation_resource_id === derivation_resource_id
            )
        }
      } else {
        this.logger.debug(`No upstream derivation found for resource '${resourceId}'.`);
      }
    }

    this.logger.debug('DerivedFromAuthorizer: finished computing credentials.');
    return otherRequirements;
  }
}
