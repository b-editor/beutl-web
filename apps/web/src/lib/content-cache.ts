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

/** Every stored replacement gets a new object key, including legacy files without a hash. */
export function contentEntityTag(file: {
  objectKey: string;
  sha256?: string | null;
}): string {
  return file.sha256 && /^[a-f\d]{64}$/iu.test(file.sha256)
    ? `"sha256-${file.sha256.toLowerCase()}"`
    : `W/"object-${encodeURIComponent(file.objectKey)}"`;
}

export function matchesContentEntityTag(header: string | null, etag: string): boolean {
  const value = etag.replace(/^W\//u, "");
  return header?.split(",").some((part) => {
    const candidate = part.trim();
    return candidate === "*" || candidate.replace(/^W\//u, "") === value;
  }) ?? false;
}

/** Whether the content routes serve this type inline, so an element can render it. */
export function servedInline(storedMimeType: string | null | undefined): boolean {
  const mimeType = storedMimeType?.split(";", 1)[0].trim().toLowerCase();
  return mimeType !== undefined && INLINE_MEDIA_TYPES.has(mimeType);
}

export function contentDeliveryHeaders(
  storedMimeType: string | null | undefined,
): Record<string, string> {
  const mimeType = storedMimeType?.split(";", 1)[0].trim().toLowerCase();
  const canRenderInline = servedInline(mimeType);

  return {
    "Content-Type": canRenderInline ? mimeType! : DOWNLOAD_CONTENT_TYPE,
    "Content-Disposition": canRenderInline ? "inline" : "attachment",
  };
}

/** An RFC 6266 disposition naming the file, with an ASCII fallback for old clients. */
export function contentDisposition(disposition: string, fileName: string): string {
  const fallback = fileName
    .replace(/[^\x20-\x7e]/gu, "_")
    .replace(/["\\]/gu, "_");
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
