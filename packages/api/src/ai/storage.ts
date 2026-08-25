import { MAX_AI_RESULT_BYTES } from "@beutl/core";
import {
  claimAiStorageCleanupForDeletion,
  completeAiJobWithOutput,
  deleteAiStorageCleanup,
  finalizeReconciledAiStorageCleanup,
  findCommittedAiOutput,
  listDueAiStorageCleanups,
  makeAiStorageCleanupDue,
  registerAiStorageCleanup,
} from "@beutl/db";

// R2 bucket injection point. The standalone worker registers its wrangler.jsonc
// binding and Next.js registers the getCloudflareContext environment through
// setR2BucketProvider, keeping API storage independent of either runtime.
const GLOBAL_KEY = "__BEUTL_R2_BUCKET_PROVIDER__";

export type R2BucketLike = {
  put(
    key: string,
    value: ArrayBuffer | ReadableStream | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get?(key: string): Promise<{
    body?: ReadableStream<Uint8Array>;
    arrayBuffer?: () => Promise<ArrayBuffer>;
    size?: number;
  } | null>;
  delete?(key: string): Promise<unknown>;
  // Whether an object is there, without reading it. Used to tell an upload that
  // was joined but never recorded from one that is still in parts.
  head?(key: string): Promise<{ size?: number } | null>;
  // A file too large for one request arrives in parts and is joined in the
  // bucket, so an upload outlives the request that started it: it is named by
  // an upload id, added to part by part, and either joined or given up.
  createMultipartUpload?(
    key: string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<{ uploadId: string }>;
  resumeMultipartUpload?(
    key: string,
    uploadId: string,
  ): {
    uploadPart(
      partNumber: number,
      value: ReadableStream<Uint8Array>,
    ): Promise<{ partNumber: number; etag: string }>;
    complete(
      parts: { partNumber: number; etag: string }[],
    ): Promise<{ size: number }>;
    abort(): Promise<void>;
  };
};

type R2BucketProvider = () => R2BucketLike;
const AI_OUTPUT_WRITE_GRACE_MILLISECONDS = 15 * 60 * 1000;
export const AI_TEXT_RESULT_RETENTION_MILLISECONDS =
  30 * 24 * 60 * 60 * 1000;
export const MAX_AI_TEXT_RESULT_BYTES = MAX_AI_RESULT_BYTES;

export class AiOutputCommitConflictError extends Error {
  constructor(jobId: string) {
    super(`AI job ${jobId} is no longer owned by this finalizer`);
    this.name = "AiOutputCommitConflictError";
  }
}

export function setR2BucketProvider(fn: R2BucketProvider): void {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = fn;
}

export function getR2Bucket(): R2BucketLike {
  const provider = (globalThis as Record<string, unknown>)[GLOBAL_KEY] as
    | R2BucketProvider
    | undefined;
  if (!provider) {
    throw new Error(
      "R2 bucket provider is not set. Call setR2BucketProvider() before using AI storage.",
    );
  }
  return provider();
}

export async function deleteAiOutputObject(objectKey: string): Promise<void> {
  const bucket = getR2Bucket();
  if (!bucket.delete) {
    throw new Error("The configured R2 bucket does not support deletion.");
  }
  await bucket.delete(objectKey);
}

// まだ組み上がっていない multipart は、オブジェクトが無いので delete では消えない。
// uploadId を持っていれば abort できる——持っていなければ、もう組み上がったか、
// 最初から multipart ではなかったかのどちらかで、delete で足りる。
async function abortMultipartIfPresent(
  objectKey: string,
  uploadId: string | null,
): Promise<void> {
  if (!uploadId) return;
  const bucket = getR2Bucket();
  if (!bucket.resumeMultipartUpload) return;
  try {
    await bucket.resumeMultipartUpload(objectKey, uploadId).abort();
  } catch (error) {
    // 組み上がっていれば abort は失敗する——そのときはオブジェクトを消せばよい。
    // その他の失敗は、もう一度回ってくれば拾える。
    console.error(`Failed to abort multipart ${objectKey}`, error);
  }
}

export async function readAiJsonResult({
  objectKey,
  maximumBytes = MAX_AI_TEXT_RESULT_BYTES,
}: {
  objectKey: string;
  maximumBytes?: number;
}): Promise<unknown> {
  const bucket = getR2Bucket();
  if (!bucket.get) {
    throw new Error("The configured R2 bucket does not support reads.");
  }
  const object = await bucket.get(objectKey);
  if (!object) throw new Error(`AI result ${objectKey} was not found`);
  if (object.size !== undefined && object.size > maximumBytes) {
    throw new Error(`AI result ${objectKey} exceeds the size limit`);
  }

  let bytes: ArrayBuffer;
  if (object.body) {
    const reader = object.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maximumBytes) {
          await reader.cancel("AI result size limit exceeded");
          throw new Error(`AI result ${objectKey} exceeds the size limit`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    bytes = combined.buffer;
  } else if (object.arrayBuffer) {
    // Legacy adapters without a stream cannot be bounded during the read. Keep
    // the post-read check, but prefer body whenever both forms are available.
    bytes = await object.arrayBuffer();
  } else {
    throw new Error(`AI result ${objectKey} cannot be read`);
  }
  if (bytes.byteLength > maximumBytes) {
    throw new Error(`AI result ${objectKey} exceeds the size limit`);
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

async function compensateAiOutputWrite(
  jobId: string,
  userId: string,
  objectKey: string,
  originalError: unknown,
  safeToCreateCleanup: boolean,
): Promise<never | Awaited<ReturnType<typeof findCommittedAiOutput>>> {
  const committed = await findCommittedAiOutput({
    jobId,
    userId,
    objectKey,
  }).catch((error) => {
    console.error("Failed to verify AI output commit", error);
    return null;
  });
  if (committed) return committed;

  let cleanupIsDurable = await makeAiStorageCleanupDue({ objectKey }).catch(
    (error) => {
      console.error("Failed to expedite AI storage cleanup", error);
      return false;
    },
  );
  if (!cleanupIsDurable && safeToCreateCleanup) {
    cleanupIsDurable = await registerAiStorageCleanup({
      objectKey,
      aiJobId: jobId,
      state: "cleanup",
      notBefore: new Date(),
    }).then(
      () => true,
      (error) => {
        console.error("Failed to restore AI storage cleanup intent", error);
        return false;
      },
    );
  }
  // A successful permanent-output commit removes the cleanup intent
  // transactionally. Ephemeral text outputs retain it with a future deadline.
  // If no intent remains (or DB state is unavailable), deleting R2 could turn
  // an ambiguously committed success into a broken output.
  if (!cleanupIsDurable) throw originalError;
  try {
    await deleteAiOutputObject(objectKey);
    await deleteAiStorageCleanup({ objectKey });
  } catch (error) {
    // The intent row was committed before the put and remains durable if either
    // R2 deletion or acknowledgement fails. Scheduled reconciliation retries it.
    console.error(`Deferred cleanup of AI output ${objectKey}`, error);
  }
  throw originalError;
}

async function saveAiOutput({
  jobId,
  userId,
  bytes,
  mimeType,
  filename,
  objectKey,
  finalizationToken,
  retentionMilliseconds,
}: {
  jobId: string;
  userId: string;
  bytes: ArrayBuffer;
  mimeType: string;
  filename: string;
  objectKey: string;
  finalizationToken?: string;
  retentionMilliseconds?: number;
}) {
  if (
    retentionMilliseconds !== undefined &&
    (!Number.isSafeInteger(retentionMilliseconds) ||
      retentionMilliseconds <= 0)
  ) {
    throw new RangeError("AI output retention must be a positive integer");
  }
  await registerAiStorageCleanup({
    objectKey,
    aiJobId: jobId,
    notBefore: new Date(Date.now() + AI_OUTPUT_WRITE_GRACE_MILLISECONDS),
  });

  let commitAttempted = false;
  try {
    const bucket = getR2Bucket();
    await bucket.put(objectKey, bytes, {
      httpMetadata: {
        contentType: mimeType,
      },
    });

    const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = Array.from(new Uint8Array(hashBuffer))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    commitAttempted = true;
    const file = await completeAiJobWithOutput({
      jobId,
      finalizationToken,
      retentionExpiresAt: retentionMilliseconds === undefined
        ? undefined
        : new Date(Date.now() + retentionMilliseconds),
      file: {
        objectKey,
        name: filename,
        size: bytes.byteLength,
        mimeType,
        userId,
        sha256,
      },
    });
    if (!file) {
      throw new AiOutputCommitConflictError(jobId);
    }
    return file;
  } catch (error) {
    const compensated = await compensateAiOutputWrite(
      jobId,
      userId,
      objectKey,
      error,
      !commitAttempted || error instanceof AiOutputCommitConflictError,
    );
    if (compensated) return compensated;
    throw error;
  }
}

// Store generated or edited image bytes in R2 and create the File record.
// Failures propagate so the caller can map them to the API error contract.
export async function saveAiImage({
  jobId,
  userId,
  bytes,
  mimeType,
  filename,
}: {
  jobId: string;
  userId: string;
  bytes: ArrayBuffer;
  mimeType: string;
  filename: string;
}) {
  return await saveAiOutput({
    jobId,
    userId,
    bytes,
    mimeType,
    filename,
    objectKey: `ai/image/${jobId}/${crypto.randomUUID()}`,
  });
}

// Store generated video bytes in R2 and create the corresponding File record.
export async function saveAiVideo({
  jobId,
  finalizationToken,
  userId,
  bytes,
  mimeType,
  filename,
}: {
  jobId: string;
  finalizationToken: string;
  userId: string;
  bytes: ArrayBuffer;
  mimeType: string;
  filename: string;
}) {
  return await saveAiOutput({
    jobId,
    finalizationToken,
    userId,
    bytes,
    mimeType,
    filename,
    objectKey: `ai/video/${jobId}/${finalizationToken}`,
  });
}

export async function saveAiJsonResult({
  jobId,
  userId,
  filename,
  result,
}: {
  jobId: string;
  userId: string;
  filename: string;
  result: unknown;
}) {
  const serialized = JSON.stringify(result);
  if (serialized === undefined) {
    throw new TypeError("AI text result must be JSON serializable");
  }
  const encoded = new TextEncoder().encode(serialized);
  if (encoded.byteLength > MAX_AI_TEXT_RESULT_BYTES) {
    throw new RangeError("AI text result exceeds the storage size limit");
  }
  const bytes = encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength,
  ) as ArrayBuffer;
  return await saveAiOutput({
    jobId,
    userId,
    bytes,
    mimeType: "application/json",
    filename,
    objectKey: `ai/text/${jobId}/${crypto.randomUUID()}`,
    retentionMilliseconds: AI_TEXT_RESULT_RETENTION_MILLISECONDS,
  });
}

export async function reconcileAiStorageCleanups(now = new Date()) {
  const cleanups = await listDueAiStorageCleanups({ now });
  let deleted = 0;
  let errors = 0;
  for (const cleanup of cleanups) {
    try {
      const claim = await claimAiStorageCleanupForDeletion({
        objectKey: cleanup.objectKey,
        state: cleanup.state,
        notBefore: cleanup.notBefore,
        now,
      });
      if (!claim.claimed) continue;
      if (!claim.shouldDeleteObject) continue;
      // まだ中断中の multipart があれば、それも。オブジェクトの delete だけでは
      // パートは消えず、行が消えたあとに誰も abort できなくなる。
      if (cleanup.uploadId) {
        await abortMultipartIfPresent(cleanup.objectKey, cleanup.uploadId);
      }
      await deleteAiOutputObject(cleanup.objectKey);
      await finalizeReconciledAiStorageCleanup({
        objectKey: cleanup.objectKey,
        aiJobId: cleanup.aiJobId,
      });
      deleted++;
    } catch (error) {
      errors++;
      console.error(
        `Failed to reconcile AI output cleanup ${cleanup.objectKey}`,
        error,
      );
    }
  }
  return { inspected: cleanups.length, deleted, errors };
}
