import "server-only";
import type { PrismaTransaction } from "@beutl/db";
import {
  commitDedicatedStorageReservation,
  createDedicatedStorageReservation,
  DEDICATED_STORAGE_WRITE_LEASE_MILLISECONDS,
  createFileAndSettleStorageWrite,
  deleteAiStorageCleanup,
  deleteFileWithStorageCleanup,
  registerAiStorageCleanup,
  recordDedicatedStorageWriteUnknown,
  recordLateDedicatedStorageWriteResult,
  releaseDedicatedStorageReservation,
  renewDedicatedStorageReservation,
  retrieveFilesByUserId,
} from "@beutl/db";
import { getCloudflareContext } from "@opennextjs/cloudflare";

const DEDICATED_STORAGE_WRITE_DEADLINE_MILLISECONDS = 30 * 1000;

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

  const bucket = getCloudflareContext().env.BEUTL_R2_BUCKET;
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
  const files = await retrieveFilesByUserId({ userId, prisma });
  let totalSize = BigInt(0);
  for (const file of files) {
    totalSize += BigInt(file.size);
  }
  return totalSize;
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
  const files = await retrieveFilesByUserId({ userId });

  let filename = file.name;
  const ext = file.name.split(".").pop();
  for (let i = 1; files.some((f) => f.name === filename); i++) {
    filename = ext
      ? file.name.replace(`.${ext}`, ` (${i}).${ext}`)
      : `${file.name} (${i})`;
  }

  const array = await file.arrayBuffer();
  const objectKey = crypto.randomUUID();
  await registerAiStorageCleanup({ objectKey, aiJobId: null, state: "writing", notBefore: new Date(Date.now() + 15 * 60_000) });
  const bucket = getCloudflareContext().env.BEUTL_R2_BUCKET;
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

/** Dedicated developer artifacts use the same transactional quota invariant as
 * multipart uploads. A durable reservation is committed before the provider
 * put, and the File commit consumes that reservation atomically. */
export async function createDedicatedStorageFile({
  file,
  userId,
  quotaBytes,
  fileCountLimit,
}: {
  file: File;
  userId: string;
  quotaBytes: bigint;
  fileCountLimit: number;
}) {
  const files = await retrieveFilesByUserId({ userId });
  let filename = file.name;
  const ext = file.name.split(".").pop();
  for (let i = 1; files.some((f) => f.name === filename); i++) {
    filename = ext ? file.name.replace(`.${ext}`, ` (${i}).${ext}`) : `${file.name} (${i})`;
  }
  const objectKey = crypto.randomUUID();
  const reservation = await createDedicatedStorageReservation({
    userId,
    id: crypto.randomUUID(),
    objectKey,
    name: filename,
    mimeType: file.type || "application/octet-stream",
    size: BigInt(file.size),
    quotaBytes,
    fileCountLimit,
  });
  if (reservation.kind !== "reserved") return reservation;
  const leaseToken = reservation.reservation.creationLeaseToken;
  let leaseUntil = reservation.reservation.creationLeaseUntil;
  if (!leaseToken || !leaseUntil) {
    throw new Error("Dedicated storage reservation did not publish a write lease");
  }
  let array: ArrayBuffer;
  try {
    array = await file.arrayBuffer();
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
  const bucket = getCloudflareContext().env.BEUTL_R2_BUCKET;
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
        await recordDedicatedStorageWriteUnknown({
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
        providerOutcomeUnknown = true;
        observeLateProviderResult();
        await recordDedicatedStorageWriteUnknown({
          id: reservation.reservation.id,
          userId,
          objectKey,
          leaseToken,
          expectedLeaseUntil: leaseUntil,
          now: new Date(),
        }).catch(() => undefined);
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
        providerOutcomeUnknown = true;
        observeLateProviderResult();
        await recordDedicatedStorageWriteUnknown({
          id: reservation.reservation.id,
          userId,
          objectKey,
          leaseToken,
          expectedLeaseUntil: leaseUntil,
          now,
        }).catch(() => undefined);
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
    });
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
