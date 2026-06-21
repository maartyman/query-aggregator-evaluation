import {BadRequestHttpError, getLoggerFor} from '@solid/community-server';
import { Verifier } from './Verifier';
import { ClaimSet } from '../ClaimSet';
import { Credential } from "../Credential";
import { ACCESSTOKEN } from '../Formats';
import {createRemoteJWKSet, jwtVerify, decodeJwt} from "jose";
import { UPSTREAMPERMISSION } from "../Claims";

/**
 * A Verifier for Access Tokens of the original sources.
 */
export class AccessTokenVerifier implements Verifier {
  protected readonly logger = getLoggerFor(this);

  /** @inheritdoc */
  public async verify(credential: Credential, claimSet: ClaimSet = {}): Promise<ClaimSet> {
    this.logger.debug(`Verifying credential ${JSON.stringify(credential)}`);
    if (credential.format !== ACCESSTOKEN) {
      throw new BadRequestHttpError(`Token format ${credential.format} does not match this processor's format.`);
    }

    try {
      const issuer =  decodeJwt(credential.token).iss as string | undefined;

      if (!issuer) {
        throw new BadRequestHttpError('Access Token missing issuer.');
      }

      const baseIssuer = issuer.endsWith('/') ? issuer : issuer + '/';
      const jwkSet = createRemoteJWKSet(
        new URL('keys', baseIssuer)
      );

      const { payload } = await jwtVerify(credential.token, jwkSet, {
        issuer: issuer,
        audience: 'solid',
      });

      for (const permission of Array.isArray(payload.permissions) ? payload.permissions as any[] : []) {
        if (!(
          'resource_id' in permission &&
          'resource_scopes' in permission &&
          Array.isArray((permission as any).resource_scopes) &&
          (permission as any).resource_scopes.includes("urn:knows:uma:scopes:derivation-read")
        )) {
          throw new Error(`Invalid RPT: 'permissions' array invalid.`);
        }

        const entry = {
          issuer: issuer,
          derivation_resource_id: (permission as any)["resource_id"] as string,
        };

        // push into claim set array for UPSTREAMPERMISSION
        claimSet[UPSTREAMPERMISSION] = claimSet[UPSTREAMPERMISSION] ?? [];
        (claimSet[UPSTREAMPERMISSION] as unknown[]).push(entry);
      }

      this.logger.info(
        `Token verified with introspection. ${JSON.stringify({ [UPSTREAMPERMISSION]: claimSet[UPSTREAMPERMISSION] })}`
      );
      return claimSet;
    } catch (error: unknown) {
      const message = `Error verifying Access Token: ${(error as Error).message}`;

      this.logger.debug(message);
      throw new BadRequestHttpError(message);
    }
  }
}
