import { BadRequestHttpError, getLoggerFor } from '@solid/community-server';
import { Verifier } from './Verifier';
import { ClaimSet } from '../ClaimSet';
import { Credential } from "../Credential";
import { createSolidTokenVerifier } from '@solid/access-token-verifier';
import { OIDC } from '../Formats';
import { CLIENTID, WEBID } from '../Claims';

/**
 * A Verifier for OIDC ID Tokens.
 */
export class SolidOidcVerifier implements Verifier {
  protected readonly logger = getLoggerFor(this);

  private readonly verifyToken = createSolidTokenVerifier();

  /** @inheritdoc */
  public async verify(credential: Credential, claimSet: ClaimSet = {}): Promise<ClaimSet> {
    this.logger.debug(`Verifying credential ${JSON.stringify(credential)}`);
    if (credential.format !== OIDC) {
      throw new BadRequestHttpError(`Token format ${credential.format} does not match this processor's format.`);
    }

    try {
      const claims = await this.verifyToken(`Bearer ${credential.token}`);

      this.logger.info(`Authenticated via a Solid OIDC. ${JSON.stringify(claims)}`);

      // Append webid and client_id claims to arrays
      claimSet[WEBID] = claimSet[WEBID] ?? [];
      (claimSet[WEBID] as unknown[]).push(claims.webid);

      if (claims.client_id) {
        claimSet[CLIENTID] = claimSet[CLIENTID] ?? [];
        (claimSet[CLIENTID] as unknown[]).push(claims.client_id);
      }

      return claimSet;

    } catch (error: unknown) {
      const message = `Error verifying OIDC ID Token: ${(error as Error).message}`;

      this.logger.debug(message);
      throw new BadRequestHttpError(message);
    }
  }
}
