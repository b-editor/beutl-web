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
// So: the object lands in the bucket under a path built from two UUIDs, and the
// route that serves it will read nothing outside that prefix. The URL is the
// capability, with 122 bits of media id on top of the job id, and it is given
// only to the provider. Nothing about the user reaches it, the object is opaque
// bytes with a declared type, and it is scheduled for deletion as it is written
// rather than when the job ends — a job that never finishes must not leave it
// behind.

import {
  getAiJobById,
  getAiJobResultFile,
  registerAiStorageCleanup,
} from "@beutl/db";
import { getR2Bucket } from "./r2-provider";
import { readAiOutputBytes } from "./storage";
import { MAX_AI_GENERATED_VIDEO_BYTES } from "./video-validation";

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
  bytes,
  mimeType,
  origin,
  now = new Date(),
}: {
  jobId: string;
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
  return { url: url.toString(), objectKey };
}

/**
 * What a finished video job produced, for a mode that works from it.
 *
 * Read before anything is reserved: an edit is charged for the source's own
 * length, and a request naming a job that is not this user's, is gone, or never
 * produced a video has to be refused before it costs anything.
 */
export async function describeSourceVideo({
  userId,
  sourceJobId,
}: {
  userId: string;
  sourceJobId: string;
}): Promise<{ durationSeconds: number } | null> {
  const [file, sourceJob] = await Promise.all([
    getAiJobResultFile({ jobId: sourceJobId, userId }),
    getAiJobById({ jobId: sourceJobId }),
  ]);
  if (
    !file ||
    sourceJob?.userId !== userId ||
    sourceJob.kind !== "video" ||
    !file.mimeType?.startsWith("video/")
  ) {
    return null;
  }
  const duration = (sourceJob.inputParams as { durationSeconds?: unknown } | null)
    ?.durationSeconds;
  return typeof duration === "number" && Number.isFinite(duration) && duration > 0
    ? { durationSeconds: Math.ceil(duration) }
    : null;
}

/**
 * Serve a finished job's video to the provider, for a mode that works from one.
 *
 * The bytes are copied rather than the stored object being shared. Sharing it
 * would mean a second way to name an object in the bucket, and a mapping from
 * capability URL to arbitrary key is exactly what the serving route refuses to
 * have — it reads one prefix and nothing else. A generated video is capped at
 * MAX_AI_GENERATED_VIDEO_BYTES, which is the same amount this service already
 * holds in memory when it finalizes one, and the copy is scheduled for
 * deletion as it is written.
 */
export async function publishSourceVideoForJob({
  jobId,
  userId,
  sourceJobId,
  origin,
  now = new Date(),
}: {
  jobId: string;
  userId: string;
  sourceJobId: string;
  origin: string;
  now?: Date;
}): Promise<{ url: string; durationSeconds: number | null } | null> {
  const [file, sourceJob] = await Promise.all([
    getAiJobResultFile({ jobId: sourceJobId, userId }),
    getAiJobById({ jobId: sourceJobId }),
  ]);
  // Someone else's job, a deleted one, or one that never produced a video.
  if (
    !file ||
    sourceJob?.userId !== userId ||
    sourceJob.kind !== "video" ||
    !file.mimeType?.startsWith("video/")
  ) {
    return null;
  }

  const bytes = await readAiOutputBytes({
    objectKey: file.objectKey,
    maximumBytes: MAX_AI_GENERATED_VIDEO_BYTES,
  });
  const { url } = await publishVideoInputMedia({
    jobId,
    bytes,
    mimeType: file.mimeType,
    origin,
    now,
  });
  // What the source is worth charging for, when the mode produces something of
  // the same length rather than a length the caller chose.
  const duration = (sourceJob.inputParams as { durationSeconds?: unknown } | null)
    ?.durationSeconds;
  return {
    url,
    durationSeconds: typeof duration === "number" && Number.isFinite(duration)
      ? duration
      : null,
  };
}

/** The bytes behind one media URL, or null when nothing is stored there. */
export async function readVideoInputMedia({
  jobId,
  mediaId,
}: {
  jobId: string;
  mediaId: string;
}): Promise<{ body: ReadableStream<Uint8Array> | null; bytes: ArrayBuffer | null } | null> {
  if (!isVideoInputMediaId(mediaId) || !isVideoInputMediaId(jobId)) return null;
  const bucket = getR2Bucket();
  if (!bucket.get) return null;
  const object = await bucket.get(videoInputObjectKey(jobId, mediaId));
  if (!object) return null;
  if (object.body) return { body: object.body, bytes: null };
  if (object.arrayBuffer) return { body: null, bytes: await object.arrayBuffer() };
  return null;
}
