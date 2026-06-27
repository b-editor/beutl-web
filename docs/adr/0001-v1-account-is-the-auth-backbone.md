# ADR 0001: v1/account is the authentication backbone (do not retire)

## Status

Accepted

## Context

With v3 being the current read API, it is tempting to assume "v3 is newest, so
retire v1 and v2". That is wrong for `src/app/api/v1/[[...route]]/account.ts`.

`v1/account` is the ONLY place that mints credentials:

- `createJwtToken` issues the access JWT via `hono/jwt` `sign()` (HS256 by
  default), using the
  `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier` claim
  for the user id.
- `createRefreshToken` / `encryptRefreshToken` produce the refresh token using
  PBKDF2 key derivation and AES-CBC encryption.

Every v3 endpoint authenticates by validating those v1-issued tokens through
`src/lib/api/auth.ts` (`getUserId`). The Beutl desktop app is hard-coupled to
the exact JWT claim names, the signature algorithm, and the refresh-token
encryption format.

## Decision

Do not delete or "retire" `v1/account`. It is authentication infrastructure,
not a legacy API version. Only narrower, genuinely-dead items inside v1 are
deprecation candidates (e.g. `/checkForUpdates`, the dead `/handler` route);
those are marked separately and gated on desktop-client telemetry.

If token issuance is ever consolidated, extract the token crypto and minting
from `v1/account.ts` into `src/lib/api/auth.ts` while keeping the claim names
and the refresh-token encryption format byte-compatible with shipped desktop
clients, and verify against captured golden tokens before shipping.

## Consequences

- v1 cannot be removed as a unit; only its dead sub-routes can be retired.
- Any change to the token crypto is a breaking change for the desktop app and
  must preserve byte compatibility.
