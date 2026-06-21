import { getLoggerFor } from '@solid/community-server';
import { Verifier } from './Verifier';
import { ClaimSet } from '../ClaimSet';
import { Credential } from "../Credential";
import { UNSECURE } from '../Formats';
import { CLIENTID, WEBID } from '../Claims';

/**
 * An UNSECURE Verifier that parses Tokens of the format `encode_uri(webId)[:encode_uri(clientId)]`,
 * without performing any further verification.
 */
export class UnsecureVerifier implements Verifier {
  protected readonly logger = getLoggerFor(this);

  constructor() {
    this.logger.warn("You are using an UnsecureVerifier. DO NOT USE THIS IN PRODUCTION !!!");
  }

  /** @inheritdoc */
  public async verify(credential: Credential, claimSet: ClaimSet = {}): Promise<ClaimSet> {
    this.logger.debug(`Verifying credential ${JSON.stringify(credential)}`);
    if (credential.format !== UNSECURE) {
      throw new Error(`Token format ${credential.format} does not match this processor's format.`);
    }

    const raw = credential.token.split(':');

    if (raw.length > 2) {
      throw new Error('Invalid token format, only one ":" is expected.');
    }

    try {
      const webid = new URL(decodeURIComponent(raw[0])).toString();
      // Ensure array and push
      claimSet[WEBID] = claimSet[WEBID] ?? [];
      claimSet[WEBID]!.push(webid);

      if (raw.length === 2) {
        const clientId = new URL(decodeURIComponent(raw[1])).toString();
        claimSet[CLIENTID] = claimSet[CLIENTID] ?? [];
        claimSet[CLIENTID]!.push(clientId);
      }

      this.logger.info(`Authenticated as via unsecure verifier. ${JSON.stringify({ [WEBID]: webid, ...(raw.length === 2 ? { [CLIENTID]: raw[1] } : {}) })}`);

      return claimSet;

    } catch (error: unknown) {
      const message = `Error verifying Access Token via WebID: ${(error as Error).message}`;

      this.logger.debug(message);
      throw new Error(message);
    }
  }
}
