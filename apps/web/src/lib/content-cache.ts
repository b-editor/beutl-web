export function contentCacheHeaders(canUsePublicCache: boolean): Record<string, string> {
  return canUsePublicCache
    ? { "Cache-Control": "public, max-age=31536000, immutable" }
    : {
        "Cache-Control": "no-store",
        Vary: "Cookie, Authorization",
      };
}
