import { PUBLIC_CONTENT_CACHE_CONTROL, PUBLIC_IMAGE_EDGE_CACHE_CONTROL } from "./content-cache";
import { CONTENT_IMAGE_VARIANTS } from "./content-image";

/** Called only for /api/contents/:id. Other requests retain the live route's semantics. */
export function isPublicImageCacheRequest(request: Request): boolean {
  const headers = request.headers;
  if (headers.has("Cookie") || headers.has("Authorization") || headers.has("Origin") ||
    headers.has("Range") || headers.has("Cache-Control") || headers.has("Pragma")) return false;

  const query = new URL(request.url).searchParams;
  const preset = query.get("image");
  return query.size === 0 || (query.size === 1 && preset !== null && Object.hasOwn(CONTENT_IMAGE_VARIANTS, preset));
}

export async function servePublicContentImage(
  request: Request,
  ctx: { waitUntil(task: Promise<unknown>): void },
  render: (request: Request) => Promise<Response>,
): Promise<Response> {
  // A named cache contains only responses admitted by the live content route.
  let cache: Cache;
  try {
    cache = await caches.open("beutl-public-content-images-v1");
    const hit = await cache.match(request);
    if (hit) {
      const response = new Response(hit.body, hit);
      response.headers.set("Cache-Control", PUBLIC_CONTENT_CACHE_CONTROL);
      return response;
    }
  } catch (error) {
    console.warn("Could not read the public image cache", error);
    return render(request);
  }

  const response = await render(request);
  if (response.status === 200 && response.body && !response.headers.has("Set-Cookie") &&
    response.headers.get("Cache-Control") === PUBLIC_CONTENT_CACHE_CONTROL &&
    response.headers.get("Cloudflare-CDN-Cache-Control") === PUBLIC_IMAGE_EDGE_CACHE_CONTROL) {
    // Cache API uses Cache-Control for expiration. Only the stored copy gets
    // the edge TTL. Both misses and hits require downstream revalidation.
    const copy = new Response(response.clone().body, response);
    copy.headers.set("Cache-Control", PUBLIC_IMAGE_EDGE_CACHE_CONTROL);
    ctx.waitUntil(cache.put(request, copy).catch((error: unknown) => {
      console.warn("Could not cache the public image", error);
    }));
  }
  return response;
}
