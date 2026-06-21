import { ClaimSet } from "../ClaimSet";
import { Credential } from "../Credential";

/**
 * A Verifier verifies Credentials, extracting their Claims.
 */
export interface Verifier {

  /**
   * Verifies the given Credential.
   *
   * @param credential - The Credential to verify.
   * @param claimSet - The existing set of claims to augment. If not provided, a new set will be created.
   * @returns The claims asserted by the Credential
   */
  verify(credential: Credential, claimSet?: ClaimSet): Promise<ClaimSet>;
}
