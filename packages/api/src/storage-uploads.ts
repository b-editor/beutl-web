import {
  claimStorageMultipartCleanup,
  claimStorageUploadForAbandon,
  countFilesByUserId,
  createFile,
  deleteClaimedStorageUpload,
  finalizeStorageMultipartCleanup,
  findStorageUploadByIdAndUserId,
  listUnknownStorageUploadCompletions,
  listDueStorageMultipartCleanups,
  markStorageUploadCompleted,
  recordStorageMultipartCleanupFailure,
  listStorageUploadsStartedBefore,
  escalateDueStorageUploadCompletions,
  settleTerminalClaimedStorageUpload,
  startRetryableTransaction,
  STORAGE_MULTIPART_SETTLEMENT_GRACE_MILLISECONDS,
  sumFileSizeByUserId,
} from "@beutl/db";
import {
  STORAGE_FILE_COUNT_LIMIT,
  STORAGE_QUOTA_BYTES,
} from "@beutl/core";
import { getR2Bucket } from "./ai/storage";

// Giving up on uploads nobody finished.
//
// A file too large for one request arrives in parts, and the bucket holds those
// parts under an upload id until they are either joined into the file or thrown
// away. A browser that is closed midway does neither, and what it left behind
// is stored — and paid for — until something abandons it.
//
// Nothing here destroys anything it has not first claimed. Reading the row and
// then acting on what it said is not enough: a completion landing in between
// would write a receipt for an object this sweep is about to delete, and the
// file would point at nothing. Claiming the row shuts that door — a claimed row
// can no longer take a receipt — so whatever is left in the bucket is this
// sweep's to throw away.
//
// Long enough that a slow upload of the largest file this service takes is
// never mistaken for an abandoned one.
const ABANDON_AFTER_MILLISECONDS = 24 * 60 * 60 * 1000;
// 取り消しの墓標を置いたまま待つ時間。遅れて現れる開始を止めるために置くもの
// なので、開始の要求が生きていられるより長く。
const TOMBSTONE_GRACE_MILLISECONDS = 15 * 60 * 1000;
const STORAGE_UPLOAD_CLEANUP_LEASE_MILLISECONDS = 5 * 60 * 1000;
const MAX_PER_RUN = 100;

export function isTerminalMultipartAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as Record<string, unknown>;
  const code = String(record.code ?? record.name ?? "").toLowerCase();
  if (code === "nosuchupload") return true;
  return /(?:\(\s*10024\s*\)|\b10024)\s*$/u.test(
    String(record.message ?? error),
  );
}

export async function reconcileStorageMultipartCleanups(
  now: Date = new Date(),
): Promise<{ inspected: number; settled: number; errors: number }> {
  const cleanups = await listDueStorageMultipartCleanups({
    now,
    limit: MAX_PER_RUN,
  });
  let settled = 0;
  let errors = 0;

  for (const cleanup of cleanups) {
    const claim = await claimStorageMultipartCleanup({
      expected: {
        objectKey: cleanup.objectKey,
        uploadId: cleanup.uploadId,
        leaseToken: cleanup.leaseToken,
        notBefore: cleanup.notBefore,
      },
      now,
    }).catch((error) => {
      errors++;
      console.error(
        "Failed to claim a multipart cleanup",
        cleanup.objectKey,
        cleanup.uploadId,
        error,
      );
      return null;
    });
    if (!claim) continue;

    try {
      const bucket = getR2Bucket();
      if (!bucket.resumeMultipartUpload) {
        throw new Error("The configured R2 bucket cannot abort a multipart upload.");
      }
      try {
        await bucket.resumeMultipartUpload(claim.objectKey, claim.uploadId).abort();
      } catch (error) {
        if (!isTerminalMultipartAbortError(error)) throw error;
      }

      const settlementAt = new Date();
      if (!await finalizeStorageMultipartCleanup({
        objectKey: claim.objectKey,
        uploadId: claim.uploadId,
        leaseToken: claim.leaseToken,
        now: settlementAt,
      })) {
        throw new Error(
          `Multipart cleanup ${claim.objectKey} ${claim.uploadId} lost its lease`,
        );
      }
      settled++;
    } catch (error) {
      errors++;
      await recordStorageMultipartCleanupFailure({
        objectKey: claim.objectKey,
        uploadId: claim.uploadId,
        leaseToken: claim.leaseToken,
        now,
        error: error instanceof Error ? error.message : String(error),
        maxAttempts: String(error instanceof Error ? error.message : error).includes("cannot abort") ? 1 : undefined,
      }).catch((failureError) => console.error("Failed to persist multipart cleanup failure", failureError));
      console.error(
        "Failed to reconcile a multipart cleanup",
        claim.objectKey,
        claim.uploadId,
        error,
      );
    }
  }

  return { inspected: cleanups.length, settled, errors };
}

export async function reconcileUnknownStorageUploadCompletions(
  limit: number = MAX_PER_RUN,
): Promise<{ inspected: number; finalized: number; errors: number }> {
  const uploads = await listUnknownStorageUploadCompletions({ limit });
  let finalized = 0;
  let errors = 0;

  for (const listed of uploads) {
    let object: { size?: number } | null;
    try {
      const head = getR2Bucket().head;
      if (!head) throw new Error("The configured R2 bucket cannot inspect objects");
      object = await head(listed.objectKey);
    } catch (error) {
      errors++;
      console.error("Failed to reconcile an unknown storage completion", listed.id, error);
      continue;
    }
    if (object === null) continue;
    if (
      typeof object.size !== "number" ||
      !Number.isSafeInteger(object.size) ||
      object.size < 0
    ) {
      errors++;
      console.error("Unknown storage completion has an invalid object size", listed.id);
      continue;
    }

    try {
      const outcome = await startRetryableTransaction(async (prisma) => {
        const current = await findStorageUploadByIdAndUserId({
          id: listed.id,
          userId: listed.userId,
          prisma,
        });
        if (
          !current ||
          current.completedFileId !== null ||
          current.abandonedAt !== null ||
          current.completionState !== "unknown" ||
          current.completionRevision !== listed.completionRevision ||
          current.objectKey !== listed.objectKey ||
          current.uploadId !== listed.uploadId ||
          current.completionInterventionAt?.getTime() !==
            listed.completionInterventionAt?.getTime()
        ) {
          return "changed" as const;
        }

        const actual = BigInt(object.size!);
        const [stored, files] = await Promise.all([
          sumFileSizeByUserId({ userId: current.userId, prisma }),
          countFilesByUserId({ userId: current.userId, prisma }),
        ]);
        if (
          stored + actual > BigInt(STORAGE_QUOTA_BYTES) ||
          files >= STORAGE_FILE_COUNT_LIMIT
        ) {
          return "blocked" as const;
        }

        const created = await createFile({
          objectKey: current.objectKey,
          name: current.name,
          size: object.size!,
          mimeType: current.mimeType,
          userId: current.userId,
          visibility: "PRIVATE",
          prisma,
        });
        if (!await markStorageUploadCompleted({
          id: current.id,
          userId: current.userId,
          fileId: created.id,
          expected: storageUploadGenerationOf(current),
          prisma,
        })) {
          throw new Error(`Unknown storage completion ${current.id} changed before receipt`);
        }
        return "finalized" as const;
      });
      if (outcome === "finalized") finalized++;
    } catch (error) {
      errors++;
      console.error("Failed to persist an unknown storage completion receipt", listed.id, error);
    }
  }

  return { inspected: uploads.length, finalized, errors };
}

export async function abandonStaleStorageUploads(
  now: Date = new Date(),
): Promise<{ abandoned: number; failed: number }> {
  // Retry rows get a bounded grace period for browser retries. Once it elapses,
  // promote them to intervention without touching R2 so closed tabs remain
  // operator-recoverable instead of fencing account deletion forever.
  await escalateDueStorageUploadCompletions({ now, limit: MAX_PER_RUN }).catch((error) => {
    console.error("Failed to escalate due storage completion retries", error);
  });
  const unknownRecovery = await reconcileUnknownStorageUploadCompletions()
    .catch((error) => {
      console.error("Failed to reconcile unknown storage completions", error);
      return { inspected: 0, finalized: 0, errors: 1 };
    });
  const stale = await listStorageUploadsStartedBefore({
    before: new Date(now.getTime() - ABANDON_AFTER_MILLISECONDS),
    now,
    limit: MAX_PER_RUN,
  });

  let abandoned = 0;
  let failed = unknownRecovery.errors;
  for (const listed of stale) {
    // 一覧を引いてから順番が回ってくるまでの間に、そのアップロードが完了して
    // いることがある。行を取れなければ、それは完了したか、既に誰かが取ったか。
    const cleanupLeaseToken = crypto.randomUUID();
    try {
      await claimStorageUploadForAbandon({
        id: listed.id,
        userId: listed.userId,
        now,
        cleanupLeaseToken,
        cleanupLeaseUntil: new Date(
          now.getTime() + STORAGE_UPLOAD_CLEANUP_LEASE_MILLISECONDS,
        ),
        requireExpiredCreationLease: true,
        expected: {
          createdAt: listed.createdAt,
          objectKey: listed.objectKey,
          uploadId: listed.uploadId,
          name: listed.name,
          mimeType: listed.mimeType,
          size: listed.size,
          partSize: listed.partSize,
          abandonedAt: listed.abandonedAt,
          startState: listed.startState,
          creationLeaseUntil: listed.creationLeaseUntil,
          creationLeaseToken: listed.creationLeaseToken,
          completionState: listed.completionState,
          completionLeaseUntil: listed.completionLeaseUntil,
          completionLeaseToken: listed.completionLeaseToken,
          completionRevision: listed.completionRevision,
          completionRetryNotBefore: listed.completionRetryNotBefore,
          cleanupLeaseUntil: listed.cleanupLeaseUntil,
          cleanupLeaseToken: listed.cleanupLeaseToken,
        },
      });
    } catch (error) {
      console.error("Failed to claim a stale storage upload", listed.id, error);
      failed++;
      continue;
    }
    // Always reload after the claim. Even when the claim failed because another
    // cleanup already owns the row, this is the only safe source of its current
    // uploadId. Acting on the list snapshot can lose a handle attached between
    // list and claim.
    let upload;
    try {
      upload = await findStorageUploadByIdAndUserId({
        id: listed.id,
        userId: listed.userId,
      });
    } catch (error) {
      console.error("Failed to reload a stale storage upload", listed.id, error);
      failed++;
      continue;
    }
    if (!upload) continue;
    if (upload.completedFileId) {
      // Completion receipts are bounded by the user's file-count limit and
      // cascade with their File row; they are never multipart sweep state.
      continue;
    }
    if (
      !upload.abandonedAt ||
      upload.cleanupLeaseToken !== cleanupLeaseToken
    ) {
      // The exact list snapshot was not claimed. A creator may have attached or
      // renewed a remote handle since the list query, so leave the current row
      // for a later sweep.
      continue;
    }

    // A pre-create intent has no observed remote handle to abort. A live creator
    // lease was excluded by the claim. Once an expired lease is claimed, delete
    // the row instead of leaving abandonedAt set on a nominally retryable intent.
    // A late creator that eventually observes a handle will fail its attach CAS
    // and compensate that handle before returning.
    if (upload.uploadId === null) {
      if (await deleteClaimedUpload(upload)) abandoned++;
      else failed++;
      continue;
    }

    // 取り消しの墓標。抱えているものは何も無いので、消せばそれで終わり——ただし
    // すぐには消さない。これは「まだ現れていない開始」を止めるために置いたもの
    // で、その開始が現れるより先に消すと、止めるつもりだったものが素通りする。
    if (upload.uploadId === "") {
      if (
        upload.createdAt.getTime() >
          now.getTime() - TOMBSTONE_GRACE_MILLISECONDS
      ) {
        continue;
      }

      if (await deleteClaimedUpload(upload)) abandoned++;
      else failed++;
      continue;
    }

    try {
      if (!await stillOwnCleanupLease(upload)) continue;
      const bucket = getR2Bucket();
      // A bucket that cannot abandon an upload would leave the row behind for
      // every later run to trip over, so say so once rather than silently.
      if (!bucket.resumeMultipartUpload) {
        throw new Error("The configured R2 bucket cannot abandon an upload.");
      }
      await bucket.resumeMultipartUpload(upload.objectKey, upload.uploadId).abort();
      // 中止できたということは、まだパートのままだった。オブジェクトは無い。
      if (await deleteClaimedUpload(upload)) abandoned++;
      else failed++;
    } catch (error) {
      console.error("Failed to abandon a stale storage upload", upload.id, error);
      // An abort failure is not proof that the multipart or a joined object is
      // gone. Keep the cleanup row and its uploadId so a later sweep can retry;
      // deleting the object or declaring success here could destroy a file that
      // completed just before the receipt was committed.
      if (isTerminalMultipartAbortError(error)) {
        // Complete may still be publishing after R2 forgets the multipart id.
        // The generation-specific key makes a delayed object deletion safe;
        // persist it atomically before dropping the upload row.
        const settlementAt = new Date();
        const settled = await settleTerminalClaimedStorageUpload({
          id: upload.id,
          userId: upload.userId,
          expected: claimedUploadExpectation(upload),
          now: settlementAt,
          objectCleanupNotBefore: new Date(
            settlementAt.getTime() +
              STORAGE_MULTIPART_SETTLEMENT_GRACE_MILLISECONDS,
          ),
        }).catch(() => false);
        if (settled) abandoned++;
        else failed++;
        continue;
      }
      failed++;
    }
  }

  return { abandoned, failed };
}

type ClaimedStorageUpload = NonNullable<
  Awaited<ReturnType<typeof findStorageUploadByIdAndUserId>>
>;

function storageUploadGenerationOf(upload: ClaimedStorageUpload) {
  return {
    createdAt: upload.createdAt,
    objectKey: upload.objectKey,
    uploadId: upload.uploadId,
    name: upload.name,
    mimeType: upload.mimeType,
    size: upload.size,
    partSize: upload.partSize,
    startState: upload.startState,
    creationLeaseUntil: upload.creationLeaseUntil,
    creationLeaseToken: upload.creationLeaseToken,
    completionState: upload.completionState,
    completionLeaseUntil: upload.completionLeaseUntil,
    completionLeaseToken: upload.completionLeaseToken,
    completionRevision: upload.completionRevision,
    completionRetryNotBefore: upload.completionRetryNotBefore,
  };
}

async function stillOwnCleanupLease(
  expected: ClaimedStorageUpload,
): Promise<boolean> {
  const current = await findStorageUploadByIdAndUserId({
    id: expected.id,
    userId: expected.userId,
  }).catch(() => null);
  return Boolean(
    current &&
    current.createdAt.getTime() === expected.createdAt.getTime() &&
    current.uploadId === expected.uploadId &&
    current.abandonedAt?.getTime() === expected.abandonedAt?.getTime() &&
    current.cleanupLeaseToken === expected.cleanupLeaseToken,
  );
}

async function deleteClaimedUpload(
  upload: ClaimedStorageUpload,
): Promise<boolean> {
  if (!upload.abandonedAt) return false;
  return await deleteClaimedStorageUpload({
    id: upload.id,
    userId: upload.userId,
    expected: claimedUploadExpectation(upload),
  });
}

function claimedUploadExpectation(upload: ClaimedStorageUpload) {
  if (!upload.abandonedAt) {
    throw new Error(`Storage upload ${upload.id} is not claimed for cleanup`);
  }
  return {
    createdAt: upload.createdAt,
    objectKey: upload.objectKey,
    uploadId: upload.uploadId,
    name: upload.name,
    mimeType: upload.mimeType,
    size: upload.size,
    partSize: upload.partSize,
    abandonedAt: upload.abandonedAt,
    startState: upload.startState,
    creationLeaseUntil: upload.creationLeaseUntil,
    creationLeaseToken: upload.creationLeaseToken,
    completionState: upload.completionState,
    completionLeaseUntil: upload.completionLeaseUntil,
    completionLeaseToken: upload.completionLeaseToken,
    completionRevision: upload.completionRevision,
    completionRetryNotBefore: upload.completionRetryNotBefore,
    cleanupLeaseUntil: upload.cleanupLeaseUntil,
    cleanupLeaseToken: upload.cleanupLeaseToken,
  };
}
