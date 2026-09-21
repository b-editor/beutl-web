# Dependency patches

## @ai-sdk/gateway 4.0.86

The image and video adapters serialize seeds using a truthiness check, which
silently omits the valid seed `0`. The patch changes both checks to test for
null/undefined in the shipped JavaScript and its TypeScript source.

`tests/contract/ai-gateway-sdk-wire.test.ts` exercises the installed SDK and
checks zero, nonzero and absent seeds on the outgoing HTTP requests. Remove
this patch when upgrading to an SDK version that passes these tests without it.

The root `pnpm.patchedDependencies` entry and lockfile apply the patch during
installation; it must remain committed with them.
