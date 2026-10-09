import { getCloudflareContext } from "@opennextjs/cloudflare";
import { contentDeliveryHeaders } from "./content-cache";

// Limit the extra buffering from cloning a stream when the cache writer and
// the client consume it at different speeds. Larger images still stream directly.
export const MAX_CACHED_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_CACHE_SECONDS = 24 * 60 * 60;
const IMAGE_CACHE_NAME = "beutl-image-content-v1";

/** Only call after checking the file's current access policy. This stores bytes,
 * not an HTTP response that could bypass authentication or retain old metadata. */
export async function getImageContentCache(request: Request, file: {
  objectKey: string;
  sha256?: string | null;
  mimeType: string | null;
  size: bigint;
}, variant?: string): Promise<{
  match(): Promise<Response | undefined>;
  put(response: Response): void;
} | null> {
  const mimeType = contentDeliveryHeaders(file.mimeType)["Content-Type"];
  if (!mimeType.startsWith("image/") || file.size <= BigInt(0) || file.size > BigInt(MAX_CACHED_IMAGE_BYTES)) {
    return null;
  }
  // Plain Next/Node development has no Worker cache or execution context.
  if (typeof caches === "undefined") return null;
  let waitUntil: (task: Promise<unknown>) => void;
  try {
    const { ctx } = getCloudflareContext();
    waitUntil = ctx.waitUntil.bind(ctx);
  } catch {
    // Worker context is absent in local Node/Next execution. Caching is
    // optional; continue serving the image from storage in that environment.
    return null;
  }

  let cache: Cache;
  try {
    // A named cache is separate from fetch's shared HTTP cache. Even private
    // image bytes can be reused here, with authorization checked on every GET.
    cache = await caches.open(IMAGE_CACHE_NAME);
  } catch (error) {
    console.error("Failed to open the image content cache", error);
    return null;
  }

  const url = new URL(request.url);
  url.pathname = `/__beutl_image_content/${encodeURIComponent(file.objectKey)}`;
  url.search = "";
  url.searchParams.set("sha256", file.sha256 ?? "");
  if (variant) url.searchParams.set("variant", variant);
  url.hash = "";
  // Never copy caller cookies, authorization, query parameters or validators.
  const key = new Request(url);
  const contentLength = file.size.toString();
  const validLength = (response: Response) => {
    const length = response.headers.get("Content-Length");
    return variant
      ? length !== null && /^\d+$/u.test(length) && Number(length) > 0 && Number(length) <= MAX_CACHED_IMAGE_BYTES
      : length === contentLength;
  };

  return {
    async match() {
      try {
        const response = await cache.match(key);
        if (response?.status === 200 && response.body && validLength(response)) {
          return response;
        }
        void response?.body?.cancel().catch(() => {});
      } catch (error) {
        console.error("Failed to read the image content cache", error);
      }
      return undefined;
    },
    put(response) {
      if (response.status !== 200 || !response.body || !validLength(response)) return;
      // Retain only bytes and their length. Delivery headers are rebuilt from
      // the live File record, so rename/unpublish/delete take effect immediately.
      const cached = new Response(response.clone().body, {
        headers: {
          "Cache-Control": `public, max-age=${IMAGE_CACHE_SECONDS}`,
          "Content-Length": response.headers.get("Content-Length")!,
          "Content-Type": "application/octet-stream",
        },
      });
      waitUntil(cache.put(key, cached).catch((error) => {
        console.error("Failed to write the image content cache", error);
      }));
    },
  };
}
