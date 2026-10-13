# Distributed Auth Verification Synthesis (Ed25519 + JWKS)

## sess-1
**USER**: Auth tokens are signed with asymmetric Ed25519 elliptic curve keys rather than symmetric HMAC-SHA256.

## sess-2
**USER**: The public keys for verifying auth signatures are served over HTTPS at the `/.well-known/jwks.json` endpoint.

