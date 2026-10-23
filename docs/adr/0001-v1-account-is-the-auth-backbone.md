# ADR 0001: v1/account is the authentication backbone (do not retire)

## Status

Accepted

## Context

With v3 being the current read API, it is tempting to assume "v3 is newest, so
retire v1 and v2". That is wrong for `packages/api/src/v1/account.ts`.

`v1/account` is the ONLY place that mints credentials:

- `createJwtToken` issues the access JWT via `hono/jwt` `sign()` (HS256 by
  default), using the
  `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier` claim
  for the user id.
- `prepareRefreshToken` / `encryptRefreshToken` produce the refresh token using
  PBKDF2 key derivation and AES-256-GCM authenticated encryption.

Every v3 endpoint authenticates by validating those v1-issued tokens through
`packages/api/src/api/auth.ts` (`getUserId`). The Beutl desktop app depends on
the JWT claim names and response fields, but stores and forwards the refresh
token as an opaque string without decrypting it.

## Decision

Do not delete or "retire" `v1/account`. It is authentication infrastructure,
not a legacy API version. Only narrower, genuinely-dead items inside v1 are
deprecation candidates (e.g. `/checkForUpdates`, the dead `/handler` route);
those are marked separately and gated on desktop-client telemetry.

If token issuance is ever consolidated, extract the token crypto and minting
from `v1/account.ts` into `packages/api/src/api/auth.ts` while keeping the JWT
claims and response fields compatible with shipped desktop clients. Verify
the refresh-token format and rotation through the actual API endpoints.

Refresh tokens use `v2.<base64(iv || salt || ciphertext || tag)>`, with a fresh
12-byte random IV, a 16-byte random salt, and a 128-bit GCM authentication tag.
PBKDF2 uses SHA-256 and 100,000 iterations with `JWT_SECRET`; the authenticated
context is `beutl:refresh-token:v2`. Both initial issuance and rotation use this
format. Reject malformed, tampered, and unversioned AES-CBC tokens with
`invalidRefreshToken` before accessing the session store. There is no CBC
fallback, because it would retain an unauthenticated decryption path.

## Consequences

- v1 cannot be removed as a unit; only its dead sub-routes can be retired.
- The AES-GCM cutover invalidates existing AES-CBC refresh tokens. Affected
  desktop sessions must sign in again after deployment; no database migration
  or desktop client change is required.
