import { AI_TEXT_RESULT_RETENTION_MILLISECONDS, MAX_AI_RESULT_BYTES } from "@beutl/core";
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
import { getR2Bucket } from "./r2-provider";

export { AI_TEXT_RESULT_RETENTION_MILLISECONDS } from "@beutl/core";
export {
  getR2Bucket,
  setR2BucketProvider,
  type R2BucketLike,
} from "./r2-provider";
const AI_OUTPUT_WRITE_GRACE_MILLISECONDS = 15 * 60 * 1000;
export const MAX_AI_TEXT_RESULT_BYTES = MAX_AI_RESULT_BYTES;

export class AiOutputCommitConflictError extends Error {
  constructor(jobId: string) {
    super(`AI job ${jobId} is no longer owned by this finalizer`);
    this.name = "AiOutputCommitConflictError";
  }
}

export async function deleteAiOutputObject(objectKey: string): Promise<void> {
  const bucket = getR2Bucket();
  if (!bucket.delete) {
    throw new Error("The configured R2 bucket does not support deletion.");
  }
  await bucket.delete(objectKey);
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
    // A finalization token identifies the job lease, not an object lifetime.
    // A retry must never reuse a key that an expired cleaner may still delete.
    objectKey: `ai/video/${jobId}/${crypto.randomUUID()}`,
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
        leaseToken: cleanup.leaseToken,
      });
      if (!claim.claimed) continue;
      if (!claim.shouldDeleteObject) continue;
      const claimedCleanup = claim.cleanup;
      // Multipart handles have their own detached abort-only outbox. This row
      // owns only object deletion, so it cannot erase a newer winner that reused
      // the same key while an older handle waited for retry.
      await deleteAiOutputObject(claimedCleanup.objectKey);
      const finalized = await finalizeReconciledAiStorageCleanup({
        objectKey: claimedCleanup.objectKey,
        aiJobId: claimedCleanup.aiJobId,
        leaseToken: claimedCleanup.leaseToken,
      });
      if (!finalized) {
        throw new Error(
          `AI storage cleanup ${claimedCleanup.objectKey} lost its claim before finalization`,
        );
      }
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
