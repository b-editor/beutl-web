# Dependency patches

## @ai-sdk/gateway 4.0.103

The image and video adapters serialize seeds using a truthiness check, which
silently omits the valid seed `0`. The patch changes both checks to test for
null/undefined in the shipped JavaScript and its TypeScript source.

`tests/contract/ai-gateway-sdk-wire.test.ts` exercises the installed SDK and
checks zero, nonzero and absent seeds on the outgoing HTTP requests. Remove
this patch when upgrading to an SDK version that passes these tests without it.

## next 16.3.8

Next strips `_rsc` from the URL that middleware sees and copies it back onto a
middleware rewrite only when the value is truthy. The fetch Next makes to
stream a Server Action's `redirect()` target carries no router headers, so its
`_rsc` is empty. On the default locale, `localeMiddleware` rewrites that
request to `/ja/...`, OpenNext hands Next the rewritten URL without `_rsc`, and
the RSC hash check answers 307 to the same URL until fetch fails with
`Too many redirects`. The patch restores the value whenever it is present, in
both the CommonJS and ESM builds of `dist/server/web/adapter.js`.

`tests/contract/next-middleware-rsc-rewrite.test.ts` runs the installed adapter
with `localeMiddleware` and checks empty, non-empty and absent `_rsc` values.
Remove this patch when upgrading to a Next version that passes these tests
without it (Next 16.4.0 and canary still use the truthy check).

The root `pnpm.patchedDependencies` entry and lockfile apply the patches during
installation; they must remain committed with them.
