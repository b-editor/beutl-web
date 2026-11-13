type CacheLike = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
};
type WaitUntil = { waitUntil(promise: Promise<unknown>): void };

const JWKS_PATH = "/api/auth/jwks";

/*
  The desktop API verifies each access token with Better Auth's resource-server
  check, which fetches this key set over HTTP the first time an isolate needs
  it. That request comes back to this Worker, where it starts Next and reads the
  keys from the database. The set holds public keys only and changes when a key
  is added: no rotation is configured. Keeping it no longer than the verifier's
  own five-minute cache lets a refetch for an unknown `kid` see a new key within
  that window.
*/
export const JWKS_CACHE_SECONDS = 300;

/**
 * Only requests without an Origin are served from the cache: a browser's
 * cross-origin request may get CORS headers that must not reach another origin.
 */
export function isCacheableJwksRequest(request: Request): boolean {
  return request.method === "GET" &&
    new URL(request.url).pathname === JWKS_PATH &&
    !request.headers.has("Origin");
}

/** Answer from the location's cache, and store a successful render for the next request. */
export async function serveJwksFromCache(
  request: Request,
  ctx: WaitUntil,
  cache: CacheLike,
  render: (request: Request) => Promise<Response>,
): Promise<Response> {
  const key = new Request(new URL(JWKS_PATH, request.url));
  const cached = await cache.match(key).catch(() => undefined);
  if (cached) return cached;

  const response = await render(request);
  if (response.status === 200) {
    const copy = response.clone();
    ctx.waitUntil((async () => {
      // Keep only what the key set needs. A Set-Cookie header would also stop
      // the cache from storing it.
      const stored = new Response(await copy.arrayBuffer(), {
        headers: {
          "Content-Type": copy.headers.get("Content-Type") ?? "application/json",
          "Cache-Control": `public, max-age=${JWKS_CACHE_SECONDS}`,
        },
      });
      await cache.put(key, stored);
    })().catch(() => undefined));
  }
  return response;
}
