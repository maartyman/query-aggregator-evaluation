import { getLoggerFor } from '@solid/community-server';
import { Verifier } from './Verifier';
import { ClaimSet } from '../ClaimSet';
import { Credential } from "../Credential";
import { JWT } from '../Formats';
import { decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import buildGetJwks, {GetJwks} from 'get-jwks';

/**
 * An UNSECURE Verifier that parses Tokens of the format `encode_uri(webId)[:encode_uri(clientId)]`,
 * without performing any further verification.
 */
export class JwtVerifier implements Verifier {
  protected readonly logger = getLoggerFor(this);
  protected jwks:GetJwks = buildGetJwks();

  constructor(
    private readonly allowedClaims: string[],
    private readonly errorOnExtraClaims: boolean,
    private readonly verifyJwt: boolean,
  ) {}

  /** @inheritdoc */
  public async verify(credential: Credential, claimSet: ClaimSet = {}): Promise<ClaimSet> {
    this.logger.debug(`Verifying credential ${JSON.stringify(credential)}`);
    if (credential.format !== JWT) {
      throw new Error(`Token format '${credential.format}' does not match this processor's format.`);
    }

    const claims = decodeJwt(credential.token);

    if (this.verifyJwt) {
      if (!claims.iss) {
        throw new Error(`JWT should contain 'iss' claim.`);
      }

      const params = decodeProtectedHeader(credential.token);

      if (!params.alg) {
        throw new Error(`JWT should contain 'alg' header.`);
      }

      if (!params.kid) {
        throw new Error(`JWT should contain 'kid' header.`);
      }

      const jwk = await this.jwks.getJwk({
        domain: claims.iss,
        alg: params.alg,
        kid: params.kid,
      });

      await jwtVerify(credential.token, Object.assign(jwk, { type: 'JWK' }));
    }

    // Only include allowed claims, and add them to the claimSet as arrays
    for (const claim of Object.keys(claims)) {
      if (!this.allowedClaims.includes(claim)) {
        if (this.errorOnExtraClaims) {
          throw new Error(`Claim '${claim}' not allowed.`);
        }
        continue;
      }

      const value = (claims as Record<string, unknown>)[claim];
      claimSet[claim] = claimSet[claim] ?? [];
      (claimSet[claim] as unknown[]).push(value);
    }

    this.logger.debug(`Returning discovered claims: ${JSON.stringify(claimSet)}`)
    return claimSet;
  }
}
