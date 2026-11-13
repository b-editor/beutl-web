import { describe, expect, it, vi } from "vitest";
import {
  isCacheableJwksRequest,
  JWKS_CACHE_SECONDS,
  serveJwksFromCache,
} from "../../apps/web/src/lib/worker-jwks-cache";

const URL_JWKS = "https://beutl.beditor.net/api/auth/jwks";
const KEYS = { keys: [{ kid: "k1", kty: "EC", alg: "ES256" }] };

function memoryCache() {
  const store = new Map<string, Response>();
  return {
    store,
    match: vi.fn(async (request: Request) => store.get(request.url)?.clone()),
    put: vi.fn(async (request: Request, response: Response) => {
      store.set(request.url, response);
    }),
  };
}

function context() {
  const pending: Promise<unknown>[] = [];
  return { pending, waitUntil: (promise: Promise<unknown>) => pending.push(promise) };
}

function renderer(response: () => Response) {
  return vi.fn(async (_request: Request) => response());
}

describe("isCacheableJwksRequest", () => {
  it("accepts a plain GET of the key set", () => {
    expect(isCacheableJwksRequest(new Request(URL_JWKS))).toBe(true);
  });

  it("leaves other methods, paths and cross-origin requests to Next", () => {
    expect(isCacheableJwksRequest(new Request(URL_JWKS, { method: "HEAD" }))).toBe(false);
    expect(isCacheableJwksRequest(new Request(URL_JWKS, { method: "POST" }))).toBe(false);
    expect(isCacheableJwksRequest(new Request("https://beutl.beditor.net/api/auth/token"))).toBe(false);
    expect(isCacheableJwksRequest(new Request(URL_JWKS, {
      headers: { Origin: "https://example.com" },
    }))).toBe(false);
  });
});

describe("serveJwksFromCache", () => {
  it("stores a rendered key set and answers the next request without rendering", async () => {
    const cache = memoryCache();
    const render = renderer(() => Response.json(KEYS));

    const first = context();
    const response = await serveJwksFromCache(new Request(URL_JWKS), first, cache, render);
    expect(await response.json()).toEqual(KEYS);
    await Promise.all(first.pending);

    const second = context();
    const cached = await serveJwksFromCache(new Request(`${URL_JWKS}?refresh=1`), second, cache, render);
    expect(await cached.json()).toEqual(KEYS);
    expect(render).toHaveBeenCalledTimes(1);
    expect(second.pending).toHaveLength(0);
  });

  it("keeps only the content type and a five-minute lifetime", async () => {
    const cache = memoryCache();
    const render = renderer(() => Response.json(KEYS, {
      headers: { "Set-Cookie": "session=1", "X-Request-Id": "abc" },
    }));
    const ctx = context();

    await serveJwksFromCache(new Request(URL_JWKS), ctx, cache, render);
    await Promise.all(ctx.pending);

    const stored = cache.store.get(URL_JWKS)!;
    expect([...stored.headers.keys()].sort()).toEqual(["cache-control", "content-type"]);
    expect(stored.headers.get("Cache-Control")).toBe(`public, max-age=${JWKS_CACHE_SECONDS}`);
    expect(stored.headers.get("Content-Type")).toBe("application/json");
    expect(JWKS_CACHE_SECONDS).toBeLessThanOrEqual(300);
  });

  it("does not store a failed render", async () => {
    const cache = memoryCache();
    const ctx = context();

    const response = await serveJwksFromCache(new Request(URL_JWKS), ctx, cache,
      renderer(() => new Response("error", { status: 500 })));

    expect(response.status).toBe(500);
    expect(ctx.pending).toHaveLength(0);
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("renders when the cache cannot be read and logs a failed write", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failure = new Error("cache unavailable");
    const cache = {
      match: vi.fn(async () => { throw failure; }),
      put: vi.fn(async () => { throw failure; }),
    };
    const ctx = context();

    try {
      const response = await serveJwksFromCache(new Request(URL_JWKS), ctx, cache,
        renderer(() => Response.json(KEYS)));

      expect(await response.json()).toEqual(KEYS);
      await expect(Promise.all(ctx.pending)).resolves.toBeDefined();
      expect(cache.put).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls.every((call) => call.includes(failure))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
