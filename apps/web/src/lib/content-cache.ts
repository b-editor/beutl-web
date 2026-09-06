const INLINE_MEDIA_TYPES = new Set([
  "audio/aac",
  "audio/flac",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/x-icon",
  "video/mp4",
  "video/ogg",
  "video/quicktime",
  "video/webm",
]);

const DOWNLOAD_CONTENT_TYPE = "application/octet-stream";
const CONTENT_SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "X-Content-Type-Options": "nosniff",
};

export function contentCacheHeaders(
  canUsePublicCache: boolean,
): Record<string, string> {
  return canUsePublicCache
    ? {
        "Cache-Control": "public, no-cache, must-revalidate",
        Vary: "Cookie, Authorization",
        ...CONTENT_SECURITY_HEADERS,
      }
    : {
        "Cache-Control": "no-store",
        Vary: "Cookie, Authorization",
        ...CONTENT_SECURITY_HEADERS,
      };
}

export function contentDeliveryHeaders(
  storedMimeType: string | null | undefined,
): Record<string, string> {
  const mimeType = storedMimeType?.split(";", 1)[0].trim().toLowerCase();
  const canRenderInline =
    mimeType !== undefined && INLINE_MEDIA_TYPES.has(mimeType);

  return {
    "Content-Type": canRenderInline ? mimeType : DOWNLOAD_CONTENT_TYPE,
    "Content-Disposition": canRenderInline ? "inline" : "attachment",
  };
}
