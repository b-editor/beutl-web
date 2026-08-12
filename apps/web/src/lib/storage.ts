import {
  cancelClaimedStorageCleanup,
  claimDueStorageCleanups,
  completeClaimedStorageCleanup,
  deferClaimedStorageCleanup,
  finalizeStorageUpload,
  markStorageCleanupReady,
  reserveStorageUpload,
  retrieveFilesByUserId,
  storageCleanupHasReferences,
} from "@beutl/db";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export type StorageBucket = Readonly<{
  put(key: string, value: ArrayBuffer): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}>;

export const storageCleanupFailureCodes = {
  initialization: "DRAIN_INITIALIZATION_FAILED",
  referenceCheck: "REFERENCE_CHECK_FAILED",
  r2Delete: "R2_DELETE_FAILED",
  databaseFinalize: "DATABASE_FINALIZE_FAILED",
  backlogCount: "BACKLOG_COUNT_FAILED",
} as const;

export type StorageCleanupFailureCode =
  typeof storageCleanupFailureCodes[keyof typeof storageCleanupFailureCodes];

export type StorageCleanupDrainResult = Readonly<{
  claimed: number;
  deleted: number;
  cancelled: number;
  deferred: number;
  failureCounts: Readonly<Record<StorageCleanupFailureCode, number>>;
}>;

export function createStorageCleanupFailureCounts(): Record<
  StorageCleanupFailureCode,
  number
> {
  return Object.fromEntries(
    Object.values(storageCleanupFailureCodes).map((code) => [code, 0]),
  ) as Record<StorageCleanupFailureCode, number>;
}

function resolveStorageBucket(bucket?: StorageBucket): StorageBucket {
  return bucket ?? getCloudflareContext().env.BEUTL_R2_BUCKET;
}

/**
 * Opportunistically drains the durable cleanup outbox. Failures are recorded
 * for retry and never replace the result of the user operation that invoked it.
 */
export async function drainStorageCleanup({
  bucket: suppliedBucket,
  limit = 10,
}: {
  bucket?: StorageBucket;
  limit?: number;
} = {}): Promise<StorageCleanupDrainResult> {
  const failureCounts = createStorageCleanupFailureCounts();
  let bucket: StorageBucket;
  let claimed;
  try {
    bucket = resolveStorageBucket(suppliedBucket);
    claimed = await claimDueStorageCleanups({ limit });
  } catch {
    failureCounts[storageCleanupFailureCodes.initialization]++;
    return {
      claimed: 0,
      deleted: 0,
      cancelled: 0,
      deferred: 0,
      failureCounts,
    };
  }

  let deleted = 0;
  let cancelled = 0;
  let deferred = 0;
  for (const cleanup of claimed) {
    try {
      if (await storageCleanupHasReferences(cleanup)) {
        await cancelClaimedStorageCleanup(cleanup);
        cancelled++;
        continue;
      }
    } catch {
      deferred++;
      failureCounts[storageCleanupFailureCodes.referenceCheck]++;
      try {
        await deferClaimedStorageCleanup({
          cleanup,
          errorCode: storageCleanupFailureCodes.referenceCheck,
        });
      } catch {
        // The lease expires, so a later invocation can retry safely.
      }
      continue;
    }

    try {
      await bucket.delete(cleanup.objectKey);
    } catch {
      deferred++;
      failureCounts[storageCleanupFailureCodes.r2Delete]++;
      try {
        await deferClaimedStorageCleanup({
          cleanup,
          errorCode: storageCleanupFailureCodes.r2Delete,
        });
      } catch {
        // The durable row and expiring lease remain available for retry.
      }
      continue;
    }

    try {
      await completeClaimedStorageCleanup(cleanup);
      deleted++;
    } catch {
      deferred++;
      failureCounts[storageCleanupFailureCodes.databaseFinalize]++;
      try {
        await deferClaimedStorageCleanup({
          cleanup,
          errorCode: storageCleanupFailureCodes.databaseFinalize,
        });
      } catch {
        // R2 delete is idempotent; the expiring lease permits a later retry.
      }
    }
  }
  return {
    claimed: claimed.length,
    deleted,
    cancelled,
    deferred,
    failureCounts,
  };
}

export async function abandonPendingStorageFile({
  fileId,
  bucket,
  errorCode = "REFERENCE_PUBLICATION_FAILED",
}: {
  fileId: string;
  bucket?: StorageBucket;
  errorCode?: string;
}): Promise<void> {
  try {
    await markStorageCleanupReady({ fileId, errorCode });
  } catch {
    // The durable reservation has its own stale timeout.
  }
  await drainStorageCleanup({ bucket });
}

export async function calcTotalFileSize({
  userId,
}: {
  userId: string;
}) {
  const files = await retrieveFilesByUserId({ userId });
  let totalSize = BigInt(0);
  for (const file of files) {
    totalSize += BigInt(file.size);
  }
  return totalSize;
}

export async function createStorageFile({
  file,
  visibility,
  userId,
  pendingReference = false,
  bucket: suppliedBucket,
}: {
  file: File;
  visibility: "PUBLIC" | "PRIVATE" | "DEDICATED";
  userId: string;
  pendingReference?: boolean;
  bucket?: StorageBucket;
}) {
  const files = await retrieveFilesByUserId({ userId });

  let filename = file.name;
  const ext = file.name.split(".").pop();
  for (let i = 1; files.some((candidate) => candidate.name === filename); i++) {
    filename = ext
      ? file.name.replace(`.${ext}`, ` (${i}).${ext}`)
      : `${file.name} (${i})`;
  }

  const cleanupId = crypto.randomUUID();
  const fileId = crypto.randomUUID();
  const objectKey = crypto.randomUUID();
  await reserveStorageUpload({ id: cleanupId, fileId, objectKey });

  const bucket = resolveStorageBucket(suppliedBucket);
  try {
    const array = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest("SHA-256", array);
    const hashHex = Array.from(new Uint8Array(hashBuffer))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    await bucket.put(objectKey, array);

    return await finalizeStorageUpload({
      cleanupId,
      pendingReference,
      file: {
        id: fileId,
        objectKey,
        name: filename,
        size: file.size,
        mimeType: file.type,
        userId,
        visibility,
        sha256: hashHex,
      },
    });
  } catch (error) {
    try {
      await markStorageCleanupReady({
        fileId,
        errorCode: "UPLOAD_PUBLICATION_FAILED",
      });
    } catch {
      // The pre-existing reservation becomes eligible after its stale timeout.
    }
    await drainStorageCleanup({ bucket });
    throw error;
  }
}
