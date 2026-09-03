import * as secureUriClaim from '@solid/access-token-verifier/dist/algorithm/verifySecureUriClaim';

type SecureUriClaimModule = typeof secureUriClaim & {
  verifySecureUriClaim: (uri: string, claim: string) => void;
};

const secureUriClaimModule = secureUriClaim as SecureUriClaimModule;
const originalVerifySecureUriClaim = secureUriClaimModule.verifySecureUriClaim;

secureUriClaimModule.verifySecureUriClaim = (uri: string, claim: string): void => {
  const parsed = new URL(uri);
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    return;
  }
  originalVerifySecureUriClaim(uri, claim);
};
