import { getCloudflareContext } from "@opennextjs/cloudflare";
import { contentEntityTag } from "./content-cache";
import { MAX_CACHED_IMAGE_BYTES } from "./image-content-cache";
import { CONTENT_IMAGE_VARIANTS, type ContentImageVariant } from "./content-image";
import { freeImageTransformsEnabled } from "./image-transform-policy";
import { isImageTransformQuotaPaused, withImageTransformQuota } from "./image-transform-quota";

const TRANSFORMABLE_TYPES = new Set([
  // AVIF input decoding requires Enterprise; this deployment uses Images Free.
  "image/jpeg", "image/png", "image/webp",
]);

/** Only call after the file's live access policy allows this request, including authentication. */
export function getContentImageVariant(request: Request, file: {
  objectKey: string;
  sha256?: string | null;
  mimeType: string | null;
  size: bigint;
}) {
  const name = new URL(request.url).searchParams.get("image");
  if (!name || !Object.hasOwn(CONTENT_IMAGE_VARIANTS, name) ||
    request.headers.has("range") || file.size <= BigInt(0) ||
    file.size > BigInt(MAX_CACHED_IMAGE_BYTES) ||
    !TRANSFORMABLE_TYPES.has(file.mimeType?.split(";", 1)[0].trim().toLowerCase() ?? "")) {
    return null;
  }

  let images: CloudflareEnv["IMAGES"];
  try {
    const { env } = getCloudflareContext();
    if (!freeImageTransformsEnabled(env)) return null;
    images = env.IMAGES;
  } catch {
    // Plain Next/Node development has no Images binding.
    return null;
  }
  if (!images) return null;

  const key = `webp-q85-v1-${name}`;
  // Transformation engines may change their encoder without changing the
  // source. A weak tag describes the representation without claiming byte parity.
  const etag = `W/${contentEntityTag(file).replace(/^W\//u, "").replace(/"$/u, `-${key}"`)}`;
  return {
    key,
    etag,
    isPaused: () => isImageTransformQuotaPaused(images),
    async transform(source: Response): Promise<Uint8Array<ArrayBuffer> | null> {
      try {
        return await withImageTransformQuota(images, async () => {
          const input = source.clone();
          try {
            const result = await images.input(input.body!)
              .transform({ ...CONTENT_IMAGE_VARIANTS[name as ContentImageVariant], fit: "scale-down" })
              .output({ format: "image/webp", quality: 85 });
            const response = result.response();
            if (!response.ok || !response.body) return null;
            return await boundedImageBytes(response.body);
          } finally {
            // Do not wait for cancellation of a tee while the fallback is unread.
            void input.body?.cancel().catch(() => {});
          }
        });
      } catch (error) {
        console.error("Failed to transform a content image", error);
        return null;
      }
    },
  };
}

async function boundedImageBytes(body: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_CACHED_IMAGE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (length === 0) return null;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
