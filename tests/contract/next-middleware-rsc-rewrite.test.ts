import { describe, expect, it, vi } from "vitest";
import { localeMiddleware } from "@beutl/next/middleware";

// The edge runtime provides this global, and Next reads it as its modules load.
await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  Object.assign(globalThis, { AsyncLocalStorage });
});
// The installed adapter that runs middleware; the patch under test lives here.
const { adapter } = await import("../../apps/web/node_modules/next/dist/server/web/adapter.js");

const ORIGIN = "https://beutl.beditor.net";

async function rewriteFor(search: string, rsc: boolean) {
  const { response } = await adapter({
    handler: localeMiddleware,
    page: "/middleware",
    request: {
      url: `${ORIGIN}/account/sign-in${search}`,
      method: "GET",
      headers: rsc ? { rsc: "1", "accept-language": "ja" } : { "accept-language": "ja" },
      nextConfig: { basePath: "", trailingSlash: false },
    },
  });
  const rewrite = response.headers.get("x-middleware-rewrite");
  expect(rewrite).not.toBeNull();
  return new URL(rewrite!);
}

// Next strips `_rsc` before middleware and puts it back on the rewrite only
// when it is truthy. A Server Action's redirect fetch has no router headers,
// so its `_rsc` is empty; OpenNext then validates the rewritten URL without it
// and answers 307 to the same address until fetch gives up.
describe("default-locale rewrite of an RSC request", () => {
  it("keeps the empty cache-busting value of a Server Action redirect fetch", async () => {
    const url = await rewriteFor("?returnUrl=https%3A%2F%2Fbeutl.beditor.net%2Fja%2Fstore%2Fdemo&_rsc", true);
    expect(url.pathname).toBe("/ja/account/sign-in");
    expect(url.searchParams.get("_rsc")).toBe("");
    expect(url.searchParams.get("returnUrl")).toBe("https://beutl.beditor.net/ja/store/demo");
  });

  it("keeps a browser navigation's hash", async () => {
    const url = await rewriteFor("?returnUrl=%2Fja&_rsc=1a2b3c4d", true);
    expect(url.searchParams.get("_rsc")).toBe("1a2b3c4d");
  });

  it("adds nothing to a document request", async () => {
    const url = await rewriteFor("?returnUrl=%2Fja", false);
    expect(url.searchParams.has("_rsc")).toBe(false);
  });
});
