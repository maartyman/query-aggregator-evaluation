function allowHttpOidcUriClaims() {
  const secureUriClaim = require('@solid/access-token-verifier/dist/algorithm/verifySecureUriClaim');
  const originalVerifySecureUriClaim = secureUriClaim.verifySecureUriClaim;

  secureUriClaim.verifySecureUriClaim = (uri, claim) => {
    const parsed = new URL(uri);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return;
    }
    originalVerifySecureUriClaim(uri, claim);
  };
}

allowHttpOidcUriClaims();
