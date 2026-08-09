export function contentCacheHeaders(isPublic: boolean): Record<string, string> {
  return isPublic
    ? { "Cache-Control": "public, max-age=31536000, immutable" }
    : {
        "Cache-Control": "no-store",
        Vary: "Cookie, Authorization",
      };
}
