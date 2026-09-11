import "server-only";
import type { PrismaTransaction } from "@beutl/db";
import {
  commitDedicatedStorageReservation,
  createDedicatedStorageReservation,
  DEDICATED_STORAGE_WRITE_LEASE_MILLISECONDS,
  createFileAndSettleStorageWrite,
  deleteAiStorageCleanup,
  deleteFileWithStorageCleanup,
  findStorageFileByIdAndUserId,
  findStorageUploadByIdAndUserId,
  getAiJobResultFile,
  registerAiStorageCleanup,
  storageFolderBelongsToUser,
  recordDedicatedStorageWriteUnknown,
  recordDedicatedStorageWriteUnknownByLeaseToken,
  recordLateDedicatedStorageWriteResult,
  releaseDedicatedStorageReservation,
  renewDedicatedStorageReservation,
  availableStorageFileName,
  resolveStorageQuota,
  startRetryableTransaction,
  sumFileSizeByUserId,
} from "@beutl/db";
import { getR2Bucket } from "@beutl/api/ai/r2-provider";
import { readAiOutputBytes, sha256Hex } from "@beutl/api";
import { getCloudflareContext } from "@opennextjs/cloudflare";

const DEDICATED_STORAGE_WRITE_DEADLINE_MILLISECONDS = 30 * 1000;
const DEDICATED_STORAGE_UNKNOWN_PERSIST_MILLISECONDS = 2 * 1000;

async function persistDedicatedStorageWriteUnknownBounded({
  id,
  userId,
  objectKey,
  leaseToken,
  expectedLeaseUntil,
  now,
}: {
  id: string;
  userId: string;
  objectKey: string;
  leaseToken: string;
  expectedLeaseUntil: Date | null;
  now: Date;
}): Promise<void> {
  const persistence = (expectedLeaseUntil
    ? recordDedicatedStorageWriteUnknown({ id, userId, objectKey, leaseToken, expectedLeaseUntil, now })
    : recordDedicatedStorageWriteUnknownByLeaseToken({ id, userId, objectKey, leaseToken, now })
  ).catch((error) => {
    console.error("Failed to persist an unknown dedicated storage write", objectKey, error);
  });
  const context = getCloudflareContext();
  context.ctx?.waitUntil?.(persistence);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      persistence,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, DEDICATED_STORAGE_UNKNOWN_PERSIST_MILLISECONDS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function deleteStorageFile({
  fileId,
  userId,
  prisma,
}: {
  fileId: string;
  userId?: string;
  prisma?: PrismaTransaction;
}) {
  const record = await deleteFileWithStorageCleanup({
    fileId: fileId,
    userId,
    prisma,
  });

  // An ambient caller transaction has not committed yet. The outbox row is
  // part of that transaction, so touching R2 here would delete a live object
  // if the caller subsequently rolls back. Let the reconciler perform the
  // remote delete after the transaction is known to have committed.
  if (prisma) return record;

  const bucket = getR2Bucket();
  try {
    if (!bucket.delete) throw new Error("The configured bucket cannot delete objects");
    await bucket.delete(record.objectKey);
    await deleteAiStorageCleanup({ objectKey: record.objectKey }).catch((cleanupError) => console.error("Failed to acknowledge storage cleanup", record.objectKey, cleanupError));
  } catch (error) {
    // deleteFileWithStorageCleanup has already committed a cleanup outbox row
    // in the same transaction as the File deletion. Re-registering here races
    // that durable row (and can turn a successful logical delete into an
    // AggregateError on a duplicate-key response), so leave the existing row
    // for the reconciler and return the committed deletion.
    console.error("Storage object deletion deferred to cleanup outbox", record.objectKey, error);
    return record;
  }
  return record;
}

export async function calcTotalFileSize({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  return await sumFileSizeByUserId({ userId, prisma });
}

/**
 * Store one object with durable receipts on both sides of the remote effect.
 * This helper intentionally owns its database transaction boundaries: letting
 * a caller wrap the outbox in a transaction would allow that transaction to
 * roll back after R2 had already accepted the object.
 */
export async function createStorageFile({
  file,
  visibility,
  userId,
}: {
  file: File;
  visibility: "PUBLIC" | "PRIVATE" | "DEDICATED";
  userId: string;
}) {
  const filename = await availableStorageFileName({ userId, name: file.name });

  const array = await file.arrayBuffer();
  const objectKey = crypto.randomUUID();
  await registerAiStorageCleanup({ objectKey, aiJobId: null, state: "writing", notBefore: new Date(Date.now() + 15 * 60_000) });
  const bucket = getR2Bucket();
  // The File record below is what callers commit against, so the object has to exist
  // first — an unawaited write can reject, or outlive the request, after they succeed.
  await bucket.put(objectKey, array);
  // sha256を計算
  const hashBuffer = await crypto.subtle.digest("SHA-256", array);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  try {
    const record = await createFileAndSettleStorageWrite({
      objectKey,
      name: filename,
      size: file.size,
      mimeType: file.type,
      userId: userId,
      visibility: visibility,
      sha256: hashHex,
    });
    await deleteAiStorageCleanup({ objectKey }).catch((cleanupError) => console.error("Failed to clear storage write outbox", objectKey, cleanupError));
    return record;
  } catch (error) {
    try {
      await registerAiStorageCleanup({ objectKey, aiJobId: null, state: "cleanup", notBefore: new Date() });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Storage record failed and cleanup could not be queued");
    }
    throw error;
  }
}

/** What a reserved storage write stores: the bytes are asked for only after
 * the quota has been reserved, so a refused write never reads them. */
export type StorageWriteSource = {
  name: string;
  mimeType: string;
  size: number;
  bytes: () => Promise<ArrayBuffer>;
};

function sourceOfFile(file: File): StorageWriteSource {
  return {
    name: file.name,
    mimeType: file.type,
    size: file.size,
    bytes: () => file.arrayBuffer(),
  };
}

/** Dedicated developer artifacts use the same transactional quota invariant as
 * multipart uploads. A durable reservation is committed before the provider
 * put, and the File commit consumes that reservation atomically.
 *
 * The quota normally comes from the account's storage plan, read inside the
 * reservation transaction. Tests pass an explicit override. */
export async function createDedicatedStorageFile({
  file,
  userId,
  quota,
  publish,
}: {
  file: File;
  userId: string;
  quota?: { quotaBytes: bigint; fileCountLimit: number };
  publish?: (tx: PrismaTransaction, record: { id: string; objectKey: string; size: bigint }) => Promise<void>;
}) {
  return await createReservedStorageFile({
    source: sourceOfFile(file),
    userId,
    visibility: "DEDICATED",
    quota,
    publish,
  });
}

// How many times one save may be attempted before it is given up on. Each
// failed attempt leaves a released reservation row behind under its own name.
const AI_RESULT_COPY_ATTEMPTS = 8;

export type AiResultStorageCopyOutcome =
  | { kind: "created"; record: { id: string; name: string; folderId: string | null } }
  | { kind: "overQuota" }
  | { kind: "tooManyFiles" }
  // An earlier attempt under the same key has not settled yet.
  | { kind: "inProgress" }
  // Every attempt this save is allowed has failed.
  | { kind: "exhausted" }
  // The chosen folder is not one of the user's, or no longer exists.
  | { kind: "folderNotFound" }
  // No finished media result under this job for this user: the job is gone,
  // still running, failed, or its result is a transcript rather than a file.
  | { kind: "unavailable" };

/** Keep a finished AI image or video in the user's storage.
 *
 * The result already sits in the bucket as the job's File, but that File is
 * outside the storage listing and its quota (a paid result cannot be refused
 * for lack of space). Keeping it means a second object under a fresh key and
 * an ordinary PRIVATE File in the chosen folder of the storage, reserved
 * against the quota like any upload. The job keeps its own result, so deleting
 * the job later does not take the copy with it, and vice versa.
 *
 * One save is one copy: the client names each save with a key, and the
 * reservation is made under a name derived from it, so a retry after a lost
 * response finds the settled reservation and gets the same receipt back
 * instead of a second file charged against the quota again. */
export async function copyAiResultToStorage({
  jobId,
  userId,
  folderId = null,
  saveKey,
}: {
  jobId: string;
  userId: string;
  folderId?: string | null;
  saveKey: string;
}): Promise<AiResultStorageCopyOutcome> {
  const result = await getAiJobResultFile({ jobId, userId });
  // Transcripts and translations are stored as JSON documents the screens turn
  // into subtitle files; there is no file to keep as it is.
  if (!result || result.mimeType === "application/json") {
    return { kind: "unavailable" };
  }
  // Asked before anything is reserved or written: a folder that is not the
  // user's is a refusal, not a file that quietly lands in the root.
  if (
    folderId !== null &&
    !(await storageFolderBelongsToUser({ folderId, userId }))
  ) {
    return { kind: "folderNotFound" };
  }
  // Every attempt of this save has a name derived from the key and its
  // number, so a retry walks the same names in the same order: a settled
  // attempt is the receipt, an attempt in flight is a refusal, and a failed
  // (released) one is stepped over to the next name. A retry of a retry thus
  // finds what the retry did; a random name for the successor would not be
  // found again. The user is part of the name, so a key guessed from someone
  // else's save can only ever meet that person's own reservations.
  let reservationId: string | null = null;
  for (let attempt = 0; attempt < AI_RESULT_COPY_ATTEMPTS; attempt++) {
    const id =
      `ai-result-copy:${await sha256Hex(`${userId}\n${jobId}\n${saveKey}\n${attempt}`)}`;
    const previous = await findStorageUploadByIdAndUserId({ id, userId });
    if (!previous) {
      reservationId = id;
      break;
    }
    if (previous.completedFileId) {
      const copy = await findStorageFileByIdAndUserId({
        id: previous.completedFileId,
        userId,
      });
      // The receipt of the save that already landed. A copy deleted since is
      // not something to redo behind the user's back.
      return copy
        ? { kind: "created", record: { id: copy.id, name: copy.name, folderId: copy.folderId } }
        : { kind: "unavailable" };
    }
    if (!previous.abandonedAt) return { kind: "inProgress" };
  }
  if (reservationId === null) return { kind: "exhausted" };
  const size = Number(result.size);
  const outcome = await createReservedStorageFile({
    source: {
      name: result.name,
      mimeType: result.mimeType,
      size,
      bytes: () =>
        readAiOutputBytes({ objectKey: result.objectKey, maximumBytes: size }),
    },
    userId,
    visibility: "PRIVATE",
    folderId,
    reservationId,
  });
  if (outcome.kind !== "created") return outcome;
  return {
    kind: "created",
    record: {
      id: outcome.record.id,
      name: outcome.record.name,
      folderId: outcome.record.folderId ?? null,
    },
  };
}

async function createReservedStorageFile({
  source,
  userId,
  visibility,
  folderId = null,
  reservationId = crypto.randomUUID(),
  quota,
  publish,
}: {
  source: StorageWriteSource;
  userId: string;
  visibility: "DEDICATED" | "PRIVATE";
  folderId?: string | null;
  // The reservation's name. A caller that derives it from its own idempotency
  // key can find the reservation again after a lost response.
  reservationId?: string;
  quota?: { quotaBytes: bigint; fileCountLimit: number };
  publish?: (tx: PrismaTransaction, record: { id: string; objectKey: string; size: bigint }) => Promise<void>;
}) {
  // Only the names that could collide are read; see availableStorageFileName.
  const filename = await availableStorageFileName({ userId, name: source.name });
  const objectKey = crypto.randomUUID();
  const reservationInput = {
    userId,
    id: reservationId,
    objectKey,
    name: filename,
    mimeType: source.mimeType || "application/octet-stream",
    size: BigInt(source.size),
  };
  const reservation = quota
    ? await createDedicatedStorageReservation({ ...reservationInput, ...quota })
    : await startRetryableTransaction(async (tx) => {
        const resolved = await resolveStorageQuota({ userId, prisma: tx });
        return await createDedicatedStorageReservation({
          ...reservationInput,
          quotaBytes: BigInt(resolved.quotaBytes),
          fileCountLimit: resolved.fileCountLimit,
          prisma: tx,
        });
      });
  if (reservation.kind !== "reserved") return reservation;
  const leaseToken = reservation.reservation.creationLeaseToken;
  let leaseUntil = reservation.reservation.creationLeaseUntil;
  if (!leaseToken || !leaseUntil) {
    throw new Error("Dedicated storage reservation did not publish a write lease");
  }
  let array: ArrayBuffer;
  try {
    array = await source.bytes();
  } catch (error) {
    await releaseDedicatedStorageReservation({
      id: reservation.reservation.id,
      userId,
      objectKey,
      leaseToken,
      expectedLeaseUntil: leaseUntil,
      now: new Date(),
    }).catch(() => undefined);
    throw error;
  }
  const bucket = getR2Bucket();
  let hashHex: string;
  try {
    const hashBuffer = await crypto.subtle.digest("SHA-256", array);
    hashHex = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch (error) {
    await releaseDedicatedStorageReservation({
      id: reservation.reservation.id,
      userId,
      objectKey,
      leaseToken,
      expectedLeaseUntil: leaseUntil,
      now: new Date(),
    }).catch(() => undefined);
    throw error;
  }
  let putSucceeded = false;
  let providerOutcomeUnknown = false;
  try {
    const putStartedAt = new Date();
    const putLeaseUntil = new Date(
      putStartedAt.getTime() + DEDICATED_STORAGE_WRITE_LEASE_MILLISECONDS,
    );
    if (!await renewDedicatedStorageReservation({
      id: reservation.reservation.id,
      userId,
      objectKey,
      leaseToken,
      expectedLeaseUntil: leaseUntil,
      leaseUntil: putLeaseUntil,
      now: putStartedAt,
    })) {
      throw new Error("Dedicated storage write lease was lost before R2 put");
    }
    leaseUntil = putLeaseUntil;
    // The reservation is committed before this provider call. A quota loser
    // therefore never reaches R2, and a crash after put leaves both the row and
    // its cleanup outbox durable for reconciliation.
    const providerPut = Promise.resolve().then(() => bucket.put(objectKey, array)).then(
      () => ({ kind: "stored" as const }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<{ kind: "deadline" }>((resolve) => {
      deadlineTimer = setTimeout(
        () => resolve({ kind: "deadline" }),
        DEDICATED_STORAGE_WRITE_DEADLINE_MILLISECONDS,
      );
    });
    const observeLateProviderResult = () => {
      const lateCleanup = providerPut.then(async () => {
        await recordLateDedicatedStorageWriteResult({
          id: reservation.reservation.id,
          userId,
          objectKey,
          now: new Date(),
        }).catch((lateError) => {
          console.error("Failed to persist late dedicated storage cleanup", objectKey, lateError);
        });
      });
      const context = getCloudflareContext();
      context.ctx?.waitUntil?.(lateCleanup);
      void lateCleanup;
    };
    for (;;) {
      let renewalTimer: ReturnType<typeof setTimeout> | undefined;
      const renew = new Promise<{ kind: "renew" }>((resolve) => {
        renewalTimer = setTimeout(
          () => resolve({ kind: "renew" }),
          Math.max(1_000, Math.floor(DEDICATED_STORAGE_WRITE_LEASE_MILLISECONDS / 3)),
        );
      });
      const outcome = await Promise.race([providerPut, renew, deadline]);
      if (outcome.kind === "deadline") {
        if (renewalTimer) clearTimeout(renewalTimer);
        deadlineTimer = undefined;
        providerOutcomeUnknown = true;
        observeLateProviderResult();
        await persistDedicatedStorageWriteUnknownBounded({
          id: reservation.reservation.id,
          userId,
          objectKey,
          leaseToken,
          expectedLeaseUntil: leaseUntil,
          now: new Date(),
        });
        throw new Error("Dedicated storage write exceeded its local deadline");
      }
      if (outcome.kind !== "renew") {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        if (renewalTimer) clearTimeout(renewalTimer);
        if (outcome.kind === "failed") throw outcome.error;
        putSucceeded = true;
        break;
      }
      const now = new Date();
      const nextLeaseUntil = new Date(
        now.getTime() + DEDICATED_STORAGE_WRITE_LEASE_MILLISECONDS,
      );
      const renewal = renewDedicatedStorageReservation({
          id: reservation.reservation.id,
          userId,
          objectKey,
          leaseToken,
          expectedLeaseUntil: leaseUntil,
          leaseUntil: nextLeaseUntil,
          now,
        }).then(
          (renewed) => ({ kind: "renewed" as const, renewed }),
          (error: unknown) => ({ kind: "renewalFailed" as const, error }),
        );
      const renewalOutcome = await Promise.race([renewal, deadline]);
      if (renewalOutcome.kind === "deadline") {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        if (renewalTimer) clearTimeout(renewalTimer);
        providerOutcomeUnknown = true;
        // Observe a renewal already in flight for a short bounded grace. If it
        // wins, use its lease as the authoritative CAS expectation; if it
        // remains hung, fall back to the immutable lease token CAS.
        const context = getCloudflareContext();
        context.ctx?.waitUntil?.(renewal);
        let lateRenewalTimer: ReturnType<typeof setTimeout> | undefined;
        const lateRenewal = await Promise.race([
          renewal,
          new Promise<null>((resolve) => {
            lateRenewalTimer = setTimeout(
              () => resolve(null),
              DEDICATED_STORAGE_UNKNOWN_PERSIST_MILLISECONDS,
            );
          }),
        ]);
        if (lateRenewalTimer) clearTimeout(lateRenewalTimer);
        const authoritativeLease = lateRenewal?.kind === "renewed" && lateRenewal.renewed
          ? nextLeaseUntil
          : null;
        if (authoritativeLease) leaseUntil = authoritativeLease;
        observeLateProviderResult();
        await persistDedicatedStorageWriteUnknownBounded({
          id: reservation.reservation.id,
          userId,
          objectKey,
          leaseToken,
          expectedLeaseUntil: authoritativeLease,
          now: new Date(),
        });
        throw new Error("Dedicated storage write exceeded its local deadline");
      }
      const renewed = renewalOutcome.kind === "renewed" && renewalOutcome.renewed;
      if (renewalOutcome.kind === "renewalFailed") {
        console.error(
          "Failed to renew dedicated storage write lease",
          objectKey,
          renewalOutcome.error,
        );
      }
      if (!renewed) {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        if (renewalTimer) clearTimeout(renewalTimer);
        providerOutcomeUnknown = true;
        observeLateProviderResult();
        await persistDedicatedStorageWriteUnknownBounded({
          id: reservation.reservation.id,
          userId,
          objectKey,
          leaseToken,
          expectedLeaseUntil: leaseUntil,
          now,
        });
        throw new Error("Dedicated storage write lease was lost");
      }
      leaseUntil = nextLeaseUntil;
    }
    const outcome = await commitDedicatedStorageReservation({
      id: reservation.reservation.id,
      userId,
      objectKey,
      sha256: hashHex,
      leaseToken,
      publish,
      visibility,
      folderId,
    });
    if (outcome.kind === "overQuota" || outcome.kind === "tooManyFiles") {
      // The plan lapsed between the reservation and this commit. The object
      // is already in the bucket; releasing the reservation queues it for
      // cleanup and frees the slot, and the caller reports the refusal the
      // same way a refused reservation is reported.
      await releaseDedicatedStorageReservation({
        id: reservation.reservation.id,
        userId,
        objectKey,
        leaseToken,
        expectedLeaseUntil: leaseUntil,
        now: new Date(),
      });
      return outcome.kind === "overQuota"
        ? { kind: "overQuota" as const }
        : { kind: "tooManyFiles" as const };
    }
    if (outcome.kind !== "created") {
      throw new Error("Dedicated storage reservation changed before File commit");
    }
    return outcome;
  } catch (error) {
    if (providerOutcomeUnknown) throw error;
    if (putSucceeded) {
      // A lost response after the transaction committed is recovered by the
      // same reservation identity. The DB helper returns the existing File
      // receipt and does not create a duplicate object or row.
      const recovered = await commitDedicatedStorageReservation({
        id: reservation.reservation.id,
        userId,
        objectKey,
        sha256: hashHex,
        leaseToken,
        publish,
        visibility,
        folderId,
      }).catch(() => null);
      if (recovered?.kind === "created") return recovered;
    }
    // Preserve both the reservation and the physical cleanup key even when the
    // provider or File transaction fails. If the transaction actually
    // committed, release returns false and leaves the settled receipt intact.
    try {
      await releaseDedicatedStorageReservation({
        id: reservation.reservation.id,
        userId,
        objectKey,
        leaseToken,
        expectedLeaseUntil: leaseUntil,
        now: new Date(),
      });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Dedicated storage write failed and cleanup could not be queued");
    }
    throw error;
  }
}
