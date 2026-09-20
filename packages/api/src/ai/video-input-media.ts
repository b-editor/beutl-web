// Pictures a video request works from, put somewhere the provider can fetch.
//
// Vercel AI Gateway persists the start request so it can run the job in the
// background, and caps what it persists at 300 KiB. A frame or reference image
// inlined as base64 passes that in one picture — this service accepts 5 MiB of
// them — and the submission comes back 413. The bytes therefore have to be
// reachable by URL, and there is nowhere in this service that served bytes by
// URL before: AI results are handed out through an authenticated route keyed to
// their owner, which a provider cannot use.
//
// The object lands under a path built from two UUIDs. Its URL also carries the
// job's random nonce, checked against the stored hash before any bucket read.
// Only the provider receives that URL. Each object is scheduled for deletion
// as it is written rather than when the job ends — a job that never finishes
// must not leave it behind.

import {
  getAiJobById,
  registerAiStorageCleanup,
} from "@beutl/db";
import { getR2Bucket } from "./r2-provider";
import { callbackNonceMatches } from "./request-integrity";

/** The prefix the serving route is confined to. */
export const AI_VIDEO_INPUT_PREFIX = "ai/video-input";

// Long enough to outlive any job a provider will still deliver — the longest
// window any provider declares is six hours — with room for a retried fetch.
const RETENTION_MILLISECONDS = 12 * 60 * 60 * 1000;

export function videoInputObjectKey(jobId: string, mediaId: string): string {
  return `${AI_VIDEO_INPUT_PREFIX}/${jobId}/${mediaId}`;
}

/** Both halves are UUIDs; anything else cannot name an object this route serves. */
const MEDIA_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function isVideoInputMediaId(value: string): boolean {
  return MEDIA_ID_PATTERN.test(value);
}

/**
 * Store one picture and return the URL a provider can fetch it from.
 *
 * `origin` is the deployment's public origin. A provider cannot reach a local
 * server, so a caller without an HTTPS origin must not get here — the same
 * condition that decides whether a callback URL is offered.
 */
export async function publishVideoInputMedia({
  jobId,
  nonce,
  bytes,
  mimeType,
  origin,
  now = new Date(),
}: {
  jobId: string;
  nonce: string;
  bytes: ArrayBuffer;
  mimeType: string;
  origin: string;
  now?: Date;
}): Promise<{ url: string; objectKey: string }> {
  const mediaId = crypto.randomUUID();
  const objectKey = videoInputObjectKey(jobId, mediaId);

  // Registered before the write, and with the job attached: an object whose
  // write is interrupted still has a row telling the reconciler to remove it.
  await registerAiStorageCleanup({
    objectKey,
    aiJobId: jobId,
    state: "cleanup",
    notBefore: new Date(now.getTime() + RETENTION_MILLISECONDS),
  });

  await getR2Bucket().put(objectKey, bytes, {
    httpMetadata: { contentType: mimeType },
  });

  const url = new URL(
    `/api/v3/ai/videos/media/${encodeURIComponent(jobId)}/${mediaId}`,
    origin,
  );
  url.searchParams.set("nonce", nonce);
  return { url: url.toString(), objectKey };
}

/** Read a job's media only after its nonce has been verified. */
export async function readVideoInputMedia({
  jobId,
  mediaId,
  nonce,
}: {
  jobId: string;
  mediaId: string;
  nonce: string | null;
}): Promise<{ body: ReadableStream<Uint8Array> | null; bytes: ArrayBuffer | null } | null> {
  if (!isVideoInputMediaId(mediaId) || !isVideoInputMediaId(jobId)) return null;
  if (!nonce || !/^[0-9a-f]{64}$/u.test(nonce)) return null;
  const job = await getAiJobById({ jobId });
  if (
    !job || job.kind !== "video" || job.deletedAt ||
    !(await callbackNonceMatches(nonce, job.callbackNonceHash))
  ) return null;
  const bucket = getR2Bucket();
  if (!bucket.get) return null;
  const object = await bucket.get(videoInputObjectKey(jobId, mediaId));
  if (!object) return null;
  if (object.body) return { body: object.body, bytes: null };
  if (object.arrayBuffer) return { body: null, bytes: await object.arrayBuffer() };
  return null;
}
