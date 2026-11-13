# Dependency patches

## @ai-sdk/gateway 4.0.132

The image and video adapters serialize seeds using a truthiness check, which
silently omits the valid seed `0`. The patch changes both checks to test for
null/undefined in the shipped JavaScript and its TypeScript source.

`tests/contract/ai-gateway-sdk-wire.test.ts` exercises the installed SDK and
checks zero, nonzero and absent seeds on the outgoing HTTP requests. Remove
this patch when upgrading to an SDK version that passes these tests without it.

## isomorphic-git 1.44.9

The published `NEEDS_CODE_POINT_ORDER` regular expression carries U+FFFF as a
raw character rather than an escape. esbuild escapes non-ASCII characters in
strings but writes regular expression literals as they are, so that one
character survives minification into the Web Worker bundle. A single character
above U+00FF makes V8 hold the whole source as UTF-16, doubling the heap the
22 MB source takes. The patch writes it as `￿` in the ESM and CommonJS
builds of the package, `managers` and `models` entry points.

`tests/contract/cloudflare-memory-footprint.test.ts` minifies those entry
points and checks that no character above U+00FF remains. Remove this patch
when upgrading to an isomorphic-git version that passes this test without it.

## next 16.4.3

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
without it (Next 16.4.3 still uses the truthy check).

The root `pnpm.patchedDependencies` entry and lockfile apply the patches during
installation; they must remain committed with them.
