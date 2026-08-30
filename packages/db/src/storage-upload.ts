import { getDb } from "./provider";
import {
  startRetryableTransaction,
  type PrismaTransaction,
} from "./transaction";

export type StorageUploadCompletionFields = {
  completionState: string;
  completionLeaseUntil: Date | null;
  completionLeaseToken: string | null;
  completionAttempts: number;
  completionLastError: string | null;
  completionInterventionAt: Date | null;
  completionRetryNotBefore: Date | null;
  unknownProbeNotBefore: Date | null;
  unknownProbeLeaseToken: string | null;
  completionRevision: number;
  reservationKind: "multipart" | "dedicated";
};

export const DEDICATED_STORAGE_WRITE_LEASE_MILLISECONDS = 60 * 1000;
export const DEDICATED_STORAGE_LATE_PUT_GRACE_MILLISECONDS = 15 * 60 * 1000;

function withCompletionFields<T extends object>(
  value: T | null,
): (T & StorageUploadCompletionFields) | null {
  return value as (T & StorageUploadCompletionFields) | null;
}

async function insertStorageUpload({
  userId,
  id,
  objectKey,
  reservationKind = "multipart",
  uploadId,
  name,
  mimeType,
  size,
  partSize,
  abandonedAt,
  startState = "active",
  creationLeaseUntil,
  creationLeaseToken,
  completionState = "idle",
  completionLeaseUntil,
  completionLeaseToken,
  completionAttempts = 0,
  completionLastError = null,
  completionInterventionAt = null,
  completionRetryNotBefore = null,
  completionRevision = 0,
  unknownProbeNotBefore = null,
  unknownProbeLeaseToken = null,
  prisma,
}: {
  userId: string;
  id: string;
  objectKey: string;
  reservationKind?: "multipart" | "dedicated";
  uploadId: string | null;
  name: string;
  mimeType: string;
  size: bigint;
  partSize: number;
  // 最初から掃除のものとして置く行。誰も知らないまま残ったマルチパートを、
  // 掃除が見つけられる場所に書き留めるために使う。
  abandonedAt?: Date;
  startState?: "intent" | "creating" | "active" | "dedicated";
  creationLeaseUntil?: Date | null;
  creationLeaseToken?: string | null;
  completionState?: "idle" | "retry" | "resumed" | "completing" | "settled" | "intervention" | "unknown";
  completionLeaseUntil?: Date | null;
  completionLeaseToken?: string | null;
  completionAttempts?: number;
  completionLastError?: string | null;
  completionInterventionAt?: Date | null;
  completionRetryNotBefore?: Date | null;
  completionRevision?: number;
  unknownProbeNotBefore?: Date | null;
  unknownProbeLeaseToken?: string | null;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  const created = await db.storageUpload.create({
    data: {
      id,
      userId,
      objectKey,
      reservationKind,
      uploadId,
      name,
      mimeType,
      size,
      partSize,
      ...(abandonedAt ? { abandonedAt } : {}),
      startState,
      creationLeaseUntil: creationLeaseUntil ?? null,
      creationLeaseToken: creationLeaseToken ?? null,
      completionState,
      completionLeaseUntil: completionLeaseUntil ?? null,
      completionLeaseToken: completionLeaseToken ?? null,
      completionAttempts,
      completionLastError,
      completionInterventionAt,
      completionRetryNotBefore,
      completionRevision,
      unknownProbeNotBefore,
      unknownProbeLeaseToken,
    },
  } as never);
  return withCompletionFields(created)!;
}

/** Reserve quota and persist a start intent before contacting the bucket. */
export async function createStorageUploadIntent({
  userId,
  id,
  objectKey,
  name,
  mimeType,
  size,
  partSize,
  prisma,
}: {
  userId: string;
  id: string;
  objectKey: string;
  name: string;
  mimeType: string;
  size: bigint;
  partSize: number;
  prisma?: PrismaTransaction;
}) {
  return insertStorageUpload({
    userId,
    id,
    objectKey,
    uploadId: null,
    name,
    mimeType,
    size,
    partSize,
    startState: "intent",
    creationLeaseUntil: null,
    prisma,
  });
}

/** Reserve a dedicated artifact's bytes and file slot before its R2 put. */
export async function createDedicatedStorageReservation({
  userId,
  id,
  objectKey,
  name,
  mimeType,
  size,
  quotaBytes,
  fileCountLimit,
  prisma,
}: {
  userId: string;
  id: string;
  objectKey: string;
  name: string;
  mimeType: string;
  size: bigint;
  quotaBytes: bigint;
  fileCountLimit: number;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    const creationLeaseToken = crypto.randomUUID();
    const creationLeaseUntil = new Date(
      Date.now() + DEDICATED_STORAGE_WRITE_LEASE_MILLISECONDS,
    );
    const [stored, reserved, files, activeUploads] = await Promise.all([
      tx.file.aggregate({ where: { userId, aiJobResult: null }, _sum: { size: true } } as never),
      tx.storageUpload.aggregate({ where: { userId, completedFileId: null }, _sum: { size: true } } as never),
      tx.file.count({ where: { userId, aiJobResult: null } } as never),
      tx.storageUpload.count({ where: { userId, completedFileId: null, abandonedAt: null } } as never),
    ]);
    const total = BigInt(stored._sum?.size ?? 0) + BigInt(reserved._sum?.size ?? 0) + size;
    if (total > quotaBytes) return { kind: "overQuota" as const };
    if (files + activeUploads >= fileCountLimit) return { kind: "tooManyFiles" as const };
    const reservation = await insertStorageUpload({
      userId,
      id,
      objectKey,
      reservationKind: "dedicated",
      uploadId: null,
      name,
      mimeType,
      size,
      partSize: 0,
      startState: "dedicated",
      creationLeaseUntil,
      creationLeaseToken,
      completionState: "completing",
      completionLeaseUntil: creationLeaseUntil,
      completionLeaseToken: creationLeaseToken,
      prisma: tx,
    });
    // Keep a physical cleanup receipt alongside the quota row. If the process
    // dies after R2 accepts the put but before File commit, the reconciler can
    // remove the object and the stale reservation can be collected safely.
    await tx.aiStorageCleanup.create({
      data: {
        objectKey,
        aiJobId: null,
        leaseToken: null,
        state: "writing",
        notBefore: new Date(Date.now() + 15 * 60_000),
      },
    } as never);
    return { kind: "reserved" as const, reservation };
  };
  return prisma ? run(prisma) : startRetryableTransaction(run);
}

export async function renewDedicatedStorageReservation({
  id,
  userId,
  objectKey,
  leaseToken,
  expectedLeaseUntil,
  leaseUntil,
  now = new Date(),
  prisma,
}: {
  id: string;
  userId: string;
  objectKey: string;
  leaseToken: string;
  expectedLeaseUntil: Date;
  leaseUntil: Date;
  now?: Date;
  prisma?: PrismaTransaction;
}) {
  if (leaseUntil.getTime() <= now.getTime()) {
    throw new RangeError("Dedicated storage write lease must expire in the future");
  }
  const db = prisma ?? await getDb();
  const renewed = await db.storageUpload.updateMany({
    where: {
      id,
      userId,
      objectKey,
      reservationKind: "dedicated",
      startState: "dedicated",
      completedFileId: null,
      abandonedAt: null,
      creationLeaseToken: leaseToken,
      creationLeaseUntil: expectedLeaseUntil,
      completionState: "completing",
      completionLeaseToken: leaseToken,
      completionLeaseUntil: expectedLeaseUntil,
    },
    data: {
      creationLeaseUntil: leaseUntil,
      completionLeaseUntil: leaseUntil,
    },
  } as never);
  return renewed.count === 1;
}

export async function recordDedicatedStorageWriteUnknown({
  id,
  userId,
  objectKey,
  leaseToken,
  expectedLeaseUntil,
  now = new Date(),
  prisma,
}: {
  id: string;
  userId: string;
  objectKey: string;
  leaseToken: string;
  expectedLeaseUntil: Date;
  now?: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const updated = await db.storageUpload.updateMany({
    where: {
      id,
      userId,
      objectKey,
      reservationKind: "dedicated",
      startState: "dedicated",
      completedFileId: null,
      abandonedAt: null,
      creationLeaseToken: leaseToken,
      creationLeaseUntil: expectedLeaseUntil,
      completionState: "completing",
      completionLeaseToken: leaseToken,
      completionLeaseUntil: expectedLeaseUntil,
    },
    data: {
      completionState: "unknown",
      completionInterventionAt: now,
      completionLastError: "Dedicated object write exceeded its local deadline",
      completionAttempts: { increment: 1 },
      completionRevision: { increment: 1 },
      completionLeaseUntil: null,
      completionLeaseToken: null,
    },
  } as never);
  return updated.count === 1;
}

/** Persist unknown completion using the immutable lease token when a renewal
 * started before the deadline settles after the caller's lease snapshot. */
export async function recordDedicatedStorageWriteUnknownByLeaseToken({
  id,
  userId,
  objectKey,
  leaseToken,
  now = new Date(),
  prisma,
}: {
  id: string;
  userId: string;
  objectKey: string;
  leaseToken: string;
  now?: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const updated = await db.storageUpload.updateMany({
    where: {
      id,
      userId,
      objectKey,
      reservationKind: "dedicated",
      startState: "dedicated",
      completedFileId: null,
      abandonedAt: null,
      creationLeaseToken: leaseToken,
      completionState: "completing",
      completionLeaseToken: leaseToken,
    },
    data: {
      completionState: "unknown",
      completionInterventionAt: now,
      completionLastError: "Dedicated object write exceeded its local deadline",
      completionAttempts: { increment: 1 },
      completionRevision: { increment: 1 },
      completionLeaseUntil: null,
      completionLeaseToken: null,
    },
  } as never);
  return updated.count === 1;
}

/** Consume a dedicated reservation and create its File in one transaction. */
export async function commitDedicatedStorageReservation({
  id,
  userId,
  objectKey,
  fileId,
  sha256,
  leaseToken,
  prisma,
}: {
  id: string;
  userId: string;
  objectKey: string;
  fileId?: string;
  sha256?: string;
  leaseToken?: string;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    const reservation = await tx.storageUpload.findFirst({
      where: { id, userId, objectKey, reservationKind: "dedicated", startState: "dedicated" },
    } as never);
    if (!reservation) {
      const existing = await tx.file.findFirst({ where: { userId, objectKey, aiJobResult: null } } as never);
      return existing ? { kind: "created" as const, record: existing } : { kind: "changed" as const };
    }
    if (reservation.completedFileId) {
      const existing = await tx.file.findFirst({ where: { id: reservation.completedFileId, userId } } as never);
      return existing ? { kind: "created" as const, record: existing } : { kind: "changed" as const };
    }
    if (
      reservation.abandonedAt ||
      (leaseToken !== undefined && reservation.creationLeaseToken !== leaseToken)
    ) return { kind: "changed" as const };
    const created = await tx.file.create({
      data: {
        id: fileId,
        objectKey: reservation.objectKey,
        name: reservation.name,
        size: reservation.size,
        mimeType: reservation.mimeType,
        userId: reservation.userId,
        visibility: "DEDICATED",
        ...(sha256 ? { sha256 } : {}),
      },
    } as never);
    const consumed = await tx.storageUpload.updateMany({
      where: {
        id,
        userId,
        objectKey,
        reservationKind: "dedicated",
        startState: "dedicated",
        completedFileId: null,
        abandonedAt: null,
        ...(leaseToken === undefined ? {} : { creationLeaseToken: leaseToken }),
      },
      data: {
        completedFileId: created.id,
        completionState: "settled",
        completionInterventionAt: null,
        completionLastError: null,
        creationLeaseUntil: null,
        creationLeaseToken: null,
        completionLeaseUntil: null,
        completionLeaseToken: null,
      },
    } as never);
    if (consumed.count !== 1) throw new Error("Dedicated storage reservation changed before commit");
    await tx.aiStorageCleanup.deleteMany({
      where: { objectKey, state: "writing", leaseToken: null },
    } as never);
    return { kind: "created" as const, record: created };
  };
  return prisma ? run(prisma) : startRetryableTransaction(run);
}

/** Mark a failed dedicated write for durable remote cleanup and release its slot. */
export async function releaseDedicatedStorageReservation({
  id,
  userId,
  objectKey,
  leaseToken,
  expectedLeaseUntil,
  now = new Date(),
  prisma,
}: {
  id: string;
  userId: string;
  objectKey: string;
  leaseToken?: string;
  expectedLeaseUntil?: Date;
  now?: Date;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    const updated = await tx.storageUpload.updateMany({
      where: {
        id,
        userId,
        objectKey,
        reservationKind: "dedicated",
        startState: "dedicated",
        completedFileId: null,
        abandonedAt: null,
        ...(leaseToken === undefined ? {} : { creationLeaseToken: leaseToken }),
        ...(expectedLeaseUntil === undefined ? {} : { creationLeaseUntil: expectedLeaseUntil }),
      },
      data: {
        abandonedAt: now,
        completionState: "idle",
        completionInterventionAt: null,
        creationLeaseUntil: null,
        creationLeaseToken: null,
        completionLeaseUntil: null,
        completionLeaseToken: null,
      },
    } as never);
    if (updated.count === 0) return false;
    await tx.aiStorageCleanup.createMany({
      data: [{ objectKey, aiJobId: null, leaseToken: null, state: "cleanup", notBefore: now }],
      skipDuplicates: true,
    } as never);
    await tx.aiStorageCleanup.updateMany({
      where: { objectKey, leaseToken: null },
      data: { state: "cleanup", notBefore: now },
    } as never);
    return true;
  };
  return prisma ? run(prisma) : startRetryableTransaction(run);
}

/** A provider put that settles after the request stopped waiting must recreate
 * the cleanup receipt even if account deletion already cascaded the user row. */
export async function recordLateDedicatedStorageWriteResult({
  id,
  userId,
  objectKey,
  now = new Date(),
  prisma,
}: {
  id: string;
  userId: string;
  objectKey: string;
  now?: Date;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    const liveFile = await tx.file.findFirst({
      where: { userId, objectKey, aiJobResult: null },
      select: { id: true },
    } as never);
    if (liveFile) return { kind: "settled" as const };

    await tx.storageUpload.updateMany({
      where: {
        id,
        userId,
        objectKey,
        reservationKind: "dedicated",
        completedFileId: null,
        abandonedAt: null,
      },
      data: {
        abandonedAt: now,
        completionState: "idle",
        completionInterventionAt: null,
        completionLeaseUntil: null,
        completionLeaseToken: null,
        creationLeaseUntil: null,
        creationLeaseToken: null,
      },
    } as never);
    await tx.aiStorageCleanup.createMany({
      data: [{
        objectKey,
        aiJobId: null,
        leaseToken: null,
        state: "cleanup",
        notBefore: now,
      }],
      skipDuplicates: true,
    } as never);
    const updated = await tx.aiStorageCleanup.updateMany({
      where: { objectKey, leaseToken: null },
      data: { aiJobId: null, state: "cleanup", notBefore: now },
    } as never);
    if (updated.count !== 1) {
      throw new Error(`Dedicated late-write cleanup ${objectKey} is already leased`);
    }
    return { kind: "cleanup" as const };
  };
  return prisma ? run(prisma) : startRetryableTransaction(run);
}

/** Persist a cancellation tombstone for an upload that never reached storage. */
export async function createStorageUploadCancellationTombstone({
  userId, id, now, prisma,
}: { userId: string; id: string; now: Date; prisma?: PrismaTransaction }) {
  return insertStorageUpload({
    userId, id, objectKey: "", uploadId: "", name: "",
    mimeType: "application/octet-stream", size: BigInt(0),
    partSize: 5 * 1024 * 1024, abandonedAt: now, startState: "active", prisma,
  });
}

/** Claim a durable intent for remote creation. Exactly one caller wins. */
export async function claimStorageUploadCreation({
  id,
  userId,
  now,
  leaseUntil,
  leaseToken,
  prisma,
}: {
  id: string;
  userId: string;
  now: Date;
  leaseUntil: Date;
  leaseToken: string;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? (await getDb());
  const result = await db.storageUpload.updateMany({
    where: {
      id,
      userId,
      uploadId: null,
      abandonedAt: null,
      OR: [
        { startState: "intent" },
        { startState: "creating", creationLeaseUntil: { lte: now } },
      ],
    },
    data: { startState: "creating", creationLeaseUntil: leaseUntil, creationLeaseToken: leaseToken },
  });
  return result.count > 0;
}

/** Attach the exact remote handle only while this creator's lease is current. */
export async function attachStorageUploadRemote({
  id,
  userId,
  uploadId,
  leaseToken,
  prisma,
}: {
  id: string;
  userId: string;
  uploadId: string;
  leaseToken: string;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? (await getDb());
  const result = await db.storageUpload.updateMany({
    where: { id, userId, uploadId: null, startState: "creating", abandonedAt: null, creationLeaseToken: leaseToken },
    data: { uploadId, startState: "active", creationLeaseUntil: null, creationLeaseToken: null },
  });
  return result.count > 0;
}

/** Publish a durable completion fence before calling the remote provider. */
export async function claimStorageUploadCompletion({
  id,
  userId,
  now,
  leaseUntil,
  leaseToken,
  expected,
  prisma,
}: {
  id: string;
  userId: string;
  now: Date;
  leaseUntil: Date;
  leaseToken: string;
  expected: StorageUploadGenerationExpectation;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  if (leaseToken.length === 0 || leaseUntil.getTime() <= now.getTime()) {
    throw new RangeError("Storage completion lease must expire in the future");
  }
  if (!["idle", "resumed"].includes(expected.completionState)) {
    return false;
  }
  if (
    expected.completionState === "resumed" &&
    (
      expected.completionRetryNotBefore === null ||
      expected.completionRetryNotBefore.getTime() <= now.getTime()
    )
  ) {
    return false;
  }
  const db = prisma ?? (await getDb());
  const result = await db.storageUpload.updateMany({
    where: {
      id,
      userId,
      ...(expected.reservationKind !== undefined ? { reservationKind: expected.reservationKind } : {}),
      completedFileId: null,
      abandonedAt: null,
      createdAt: expected.createdAt,
      objectKey: expected.objectKey,
      uploadId: expected.uploadId,
      name: expected.name,
      mimeType: expected.mimeType,
      size: expected.size,
      partSize: expected.partSize,
      startState: expected.startState,
      creationLeaseUntil: expected.creationLeaseUntil,
      creationLeaseToken: expected.creationLeaseToken,
      completionState: expected.completionState,
      completionRetryNotBefore: expected.completionRetryNotBefore,
      ...(expected.unknownProbeLeaseToken !== undefined ? { unknownProbeLeaseToken: expected.unknownProbeLeaseToken, unknownProbeNotBefore: expected.unknownProbeNotBefore } : {}),
      completionLeaseUntil: null,
      completionLeaseToken: null,
      completionRevision: expected.completionRevision,
      cleanupLeaseUntil: null,
      cleanupLeaseToken: null,
    },
    data: {
      completionState: "completing",
      completionLeaseUntil: leaseUntil,
      completionLeaseToken: leaseToken,
      completionRetryNotBefore: null,
      unknownProbeNotBefore: null,
      unknownProbeLeaseToken: null,
    },
  } as never);
  return result.count === 1;
}

/** Extend an in-flight completion fence while the provider call is running. */
export async function renewStorageUploadCompletion({
  id,
  userId,
  now,
  leaseUntil,
  leaseToken,
  expected,
  prisma,
}: {
  id: string;
  userId: string;
  now: Date;
  leaseUntil: Date;
  leaseToken: string;
  expected: StorageUploadGenerationExpectation;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  if (leaseUntil.getTime() <= now.getTime()) {
    throw new RangeError("Storage completion lease must expire in the future");
  }
  const db = prisma ?? (await getDb());
  const result = await db.storageUpload.updateMany({
    where: {
      id,
      userId,
      ...(expected.reservationKind !== undefined ? { reservationKind: expected.reservationKind } : {}),
      completedFileId: null,
      abandonedAt: null,
      createdAt: expected.createdAt,
      objectKey: expected.objectKey,
      uploadId: expected.uploadId,
      name: expected.name,
      mimeType: expected.mimeType,
      size: expected.size,
      partSize: expected.partSize,
      startState: expected.startState,
      creationLeaseUntil: expected.creationLeaseUntil,
      creationLeaseToken: expected.creationLeaseToken,
      completionState: "completing",
      completionLeaseToken: leaseToken,
      completionLeaseUntil: expected.completionLeaseUntil,
      completionRevision: expected.completionRevision,
      completionRetryNotBefore: expected.completionRetryNotBefore,
    },
    data: { completionLeaseUntil: leaseUntil },
  } as never);
  return result.count === 1;
}

export const STORAGE_UPLOAD_COMPLETION_MAX_ATTEMPTS = 3;

/** Persist an ambiguous provider outcome; after a bounded number of attempts stop automatic retries. */
export async function recordStorageUploadCompletionFailure({
  id, userId, leaseToken, expected, error, now,
  maxAttempts = STORAGE_UPLOAD_COMPLETION_MAX_ATTEMPTS, prisma,
}: { id: string; userId: string; leaseToken: string; expected: StorageUploadGenerationExpectation; error: string; now: Date; maxAttempts?: number; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  const generation = {
    id,
    userId,
    ...(expected.reservationKind !== undefined ? { reservationKind: expected.reservationKind } : {}),
    completedFileId: null,
    abandonedAt: null,
    createdAt: expected.createdAt,
    objectKey: expected.objectKey,
    uploadId: expected.uploadId,
    name: expected.name,
    mimeType: expected.mimeType,
    size: expected.size,
    partSize: expected.partSize,
    startState: expected.startState,
    creationLeaseUntil: expected.creationLeaseUntil,
    creationLeaseToken: expected.creationLeaseToken,
    completionState: "completing",
    completionLeaseToken: leaseToken,
    completionLeaseUntil: expected.completionLeaseUntil,
    completionRevision: expected.completionRevision,
    completionRetryNotBefore: expected.completionRetryNotBefore,
    ...(expected.unknownProbeLeaseToken !== undefined ? { unknownProbeLeaseToken: expected.unknownProbeLeaseToken, unknownProbeNotBefore: expected.unknownProbeNotBefore } : {}),
  } as const;
  const current = await db.storageUpload.findFirst({ where: generation } as never);
  if (!current) return { status: "lost" as const };
  const attempts = (current as typeof current & { completionAttempts?: number }).completionAttempts ?? 0;
  const nextAttempts = attempts + 1;
  const intervene = nextAttempts >= maxAttempts;
  const updated = await db.storageUpload.updateMany({
    where: generation,
    data: {
      completionAttempts: nextAttempts,
      completionLastError: error.slice(0, 2000),
      completionState: intervene ? "intervention" : "retry",
      completionInterventionAt: intervene ? now : null,
      completionRetryNotBefore: intervene ? null : new Date(now.getTime() + 15 * 60_000),
      completionLeaseUntil: null,
      completionLeaseToken: null,
      completionRevision: { increment: 1 },
    },
  } as never);
  return updated.count === 1 ? { status: intervene ? "intervention" as const : "retry" as const, attempts: nextAttempts } : { status: "lost" as const };
}

/**
 * Persist an outcome that cannot be retried because the provider call may
 * still commit after this runtime stopped waiting (for example, a deadline
 * timeout). The row remains operator-visible but never authorizes another
 * provider completion.
 */
export async function recordStorageUploadCompletionUnknown({
  id, userId, leaseToken, expected, error, now, prisma,
}: { id: string; userId: string; leaseToken: string; expected: StorageUploadGenerationExpectation; error: string; now: Date; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  const generation = {
    id,
    userId,
    completedFileId: null,
    abandonedAt: null,
    createdAt: expected.createdAt,
    objectKey: expected.objectKey,
    uploadId: expected.uploadId,
    name: expected.name,
    mimeType: expected.mimeType,
    size: expected.size,
    partSize: expected.partSize,
    startState: expected.startState,
    creationLeaseUntil: expected.creationLeaseUntil,
    creationLeaseToken: expected.creationLeaseToken,
    completionState: "completing",
    completionLeaseToken: leaseToken,
    completionLeaseUntil: expected.completionLeaseUntil,
    completionRevision: expected.completionRevision,
    completionRetryNotBefore: expected.completionRetryNotBefore,
    ...(expected.unknownProbeLeaseToken !== undefined ? { unknownProbeLeaseToken: expected.unknownProbeLeaseToken, unknownProbeNotBefore: expected.unknownProbeNotBefore } : {}),
  } as const;
  const current = await db.storageUpload.findFirst({ where: generation } as never);
  if (!current) return { status: "lost" as const };
  const attempts = (current as typeof current & { completionAttempts?: number }).completionAttempts ?? 0;
  const updated = await db.storageUpload.updateMany({
    where: generation,
    data: {
      completionAttempts: attempts + 1,
      completionLastError: error.slice(0, 2000),
      completionState: "unknown",
      completionInterventionAt: now,
      completionRetryNotBefore: null,
      completionLeaseUntil: null,
      completionLeaseToken: null,
      completionRevision: { increment: 1 },
    },
  } as never);
  return updated.count === 1 ? { status: "unknown" as const, attempts: attempts + 1 } : { status: "lost" as const };
}

export async function recordStorageUploadCompletionLateFailure({
  id, userId, expected, expectedInterventionAt, error, prisma,
}: { id: string; userId: string; expected: StorageUploadGenerationExpectation; expectedInterventionAt: Date; error: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  const updated = await db.storageUpload.updateMany({
    where: {
      id,
      userId,
      completedFileId: null,
      abandonedAt: null,
      createdAt: expected.createdAt,
      objectKey: expected.objectKey,
      uploadId: expected.uploadId,
      name: expected.name,
      mimeType: expected.mimeType,
      size: expected.size,
      partSize: expected.partSize,
      startState: expected.startState,
      creationLeaseUntil: expected.creationLeaseUntil,
      creationLeaseToken: expected.creationLeaseToken,
      completionState: "unknown",
      completionInterventionAt: expectedInterventionAt,
      completionLeaseUntil: null,
      completionLeaseToken: null,
      completionRetryNotBefore: expected.completionRetryNotBefore,
      completionRevision: expected.completionRevision,
      cleanupLeaseUntil: null,
      cleanupLeaseToken: null,
    },
    data: {
      completionLastError: error.slice(0, 2000),
      completionRevision: { increment: 1 },
    },
  } as never);
  return updated.count === 1 ? { status: "unknown" as const } : { status: "lost" as const };
}

export async function listStorageUploadInterventions({ limit = 100, prisma }: { limit?: number; prisma?: PrismaTransaction } = {}) {
  const db = prisma ?? await getDb();
  // Fetch all actionable interventions up to the requested limit before filling
  // with unknowns, so unknown rows can never hide operator work.
  const interventionLimit = limit;
  const [interventions, unknowns] = await Promise.all([
    db.storageUpload.findMany({ where: { completionState: "intervention" }, orderBy: [{ completionInterventionAt: "asc" }, { createdAt: "asc" }], take: interventionLimit } as never),
    db.storageUpload.findMany({ where: { completionState: "unknown" }, orderBy: [{ completionInterventionAt: "asc" }, { createdAt: "asc" }], take: limit } as never),
  ]);
  return [...interventions, ...unknowns].slice(0, limit);
}

const UNKNOWN_RECOVERY_LEASE_MILLISECONDS = 5 * 60 * 1000;

export async function listUnknownStorageUploadCompletions({ limit = 100, now = new Date(), prisma }: { limit?: number; now?: Date; prisma?: PrismaTransaction } = {}) {
  const db = prisma ?? await getDb();
  if (limit <= 0) return [];
  const base = {
    completionState: "unknown",
    reservationKind: "multipart",
    completedFileId: null,
    abandonedAt: null,
  } as const;
  // Never-probed rows have strict priority. At the five-minute scheduler tick,
  // the previous batch becomes due at the same time as this worker runs again;
  // relying on database-specific NULL ordering could let that old batch occupy
  // every slot forever and starve rows beyond the first page.
  const unprobed = await db.storageUpload.findMany({
    where: {
      ...base,
      unknownProbeNotBefore: null,
    },
    orderBy: [{ completionInterventionAt: "asc" }, { createdAt: "asc" }],
    take: limit,
  } as never);
  const remaining = limit - unprobed.length;
  if (remaining === 0) {
    return unprobed.map((row) => withCompletionFields(row)!);
  }
  const due = await db.storageUpload.findMany({
    where: {
      ...base,
      unknownProbeNotBefore: { lte: now },
      // `lte` excludes NULL in SQL, but spell the partition out so correctness
      // does not depend on an ORM or test provider preserving that behavior.
      NOT: { unknownProbeNotBefore: null },
    },
    orderBy: [{ unknownProbeNotBefore: "asc" }, { completionInterventionAt: "asc" }, { createdAt: "asc" }],
    take: remaining,
  } as never);
  return [...unprobed, ...due].map((row) => withCompletionFields(row)!);
}

/** Claim one unknown row for a bounded recovery probe. The retry timestamp is
 * both a durable lease and a fair-scheduling cursor: a crashed worker becomes
 * eligible again, while concurrent workers cannot probe the same row. */
export async function claimUnknownStorageUploadCompletion({
  id,
  userId,
  objectKey,
  uploadId,
  expectedRevision,
  expectedInterventionAt,
  now = new Date(),
  prisma,
}: {
  id: string;
  userId: string;
  objectKey: string;
  uploadId: string | null;
  expectedRevision: number;
  expectedInterventionAt: Date;
  now?: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const leaseUntil = new Date(now.getTime() + UNKNOWN_RECOVERY_LEASE_MILLISECONDS);
  const leaseToken = crypto.randomUUID();
  const updated = await db.storageUpload.updateMany({
    where: {
      id,
      userId,
      objectKey,
      uploadId,
      completionState: "unknown",
      completedFileId: null,
      abandonedAt: null,
      completionRevision: expectedRevision,
      completionInterventionAt: expectedInterventionAt,
      OR: [{ unknownProbeNotBefore: null }, { unknownProbeNotBefore: { lte: now } }],
    },
    data: { unknownProbeNotBefore: leaseUntil, unknownProbeLeaseToken: leaseToken, completionRevision: { increment: 1 } },
  } as never);
  if (updated.count !== 1) return null;
  return await db.storageUpload.findFirst({ where: { id, userId, completionState: "unknown", completionRevision: expectedRevision + 1, unknownProbeLeaseToken: leaseToken } } as never).then((row) => withCompletionFields(row));
}

/** Promote retry rows whose grace period elapsed into operator intervention. */
export async function escalateDueStorageUploadCompletions({ now, limit = 100, prisma }: { now: Date; limit?: number; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  const due = await db.storageUpload.findMany({ where: { OR: [{ completionState: "retry", completionRetryNotBefore: { lte: now } }, { completionState: "resumed", completionRetryNotBefore: { lte: now } }, { completionState: "completing", completionLeaseUntil: { lte: now } }] }, orderBy: [{ completionRetryNotBefore: "asc" }, { createdAt: "asc" }], take: limit } as never);
  let escalated = 0;
  for (const row of due as unknown as Array<{ id: string; userId: string; objectKey: string; uploadId: string | null; completionState: string; completionRetryNotBefore: Date | null; completionLeaseToken: string | null; completionLeaseUntil: Date | null; completionRevision: number; completionAttempts: number; completionLastError: string | null }>) {
    const completing = row.completionState === "completing";
    const resumed = row.completionState === "resumed";
    const updated = await db.storageUpload.updateMany({
      where: { id: row.id, userId: row.userId, objectKey: row.objectKey, uploadId: row.uploadId, completionState: row.completionState, completionRetryNotBefore: row.completionRetryNotBefore, completionLeaseToken: row.completionLeaseToken, completionLeaseUntil: row.completionLeaseUntil, completionRevision: row.completionRevision, completionAttempts: row.completionAttempts, completionLastError: row.completionLastError, completionInterventionAt: null },
      data: { completionState: completing ? "unknown" : "intervention", completionInterventionAt: now, completionRetryNotBefore: null, completionLeaseToken: null, completionLeaseUntil: null, completionLastError: completing ? "Completion lease expired without a recorded outcome" : resumed ? "Operator resume expired before a provider attempt" : row.completionLastError, completionAttempts: completing ? row.completionAttempts + 1 : row.completionAttempts, completionRevision: { increment: 1 } },
    } as never);
    if (updated.count === 1) escalated++;
  }
  return escalated;
}

type StorageUploadInterventionIdentity = { id: string; userId: string; objectKey: string; uploadId: string | null; expectedRevision: number; expectedInterventionAt: Date };

export async function resumeStorageUploadIntervention({ id, userId, objectKey, uploadId, expectedRevision, expectedInterventionAt, now, operatorUserId, operatorReason, operatorEvidence, prisma }: StorageUploadInterventionIdentity & { now: Date; operatorUserId: string; operatorReason: string; operatorEvidence: string; prisma?: PrismaTransaction }) {
  if (!operatorUserId.trim() || operatorReason.trim().length < 10 || operatorEvidence.trim().length < 10) return { status: "unsafe" as const, reason: "Operator identity, reason, and evidence are required" };
  const db = prisma ?? await getDb();
  const current = await db.storageUpload.findFirst({ where: { id, userId, objectKey, uploadId, completionState: { in: ["unknown", "intervention"] }, completionRevision: expectedRevision, completionInterventionAt: expectedInterventionAt } } as never) as { completionState?: string } | null;
  if (current?.completionState === "unknown") return { status: "unsafe" as const, reason: "Provider completion outcome is unknown; verify the receipt or object before any further action" };
  const updated = await db.storageUpload.updateMany({ where: { id, userId, objectKey, uploadId, completionState: "intervention", completionRevision: expectedRevision, completionInterventionAt: expectedInterventionAt }, data: { completionState: "resumed", completionInterventionAt: null, completionRetryNotBefore: new Date(now.getTime() + 15 * 60_000), completionLeaseToken: null, completionLeaseUntil: null, completionRevision: { increment: 1 }, } } as never);
  return updated.count === 1 ? { status: "resumed" as const, revision: expectedRevision + 1 } : { status: "conflict" as const };
}

export async function terminalizeStorageUploadIntervention({ id, userId, objectKey, uploadId, expectedRevision, expectedInterventionAt, now, operatorUserId, operatorReason, operatorEvidence, prisma }: StorageUploadInterventionIdentity & { now: Date; operatorUserId: string; operatorReason: string; operatorEvidence: string; prisma?: PrismaTransaction }) {
  if (!operatorUserId.trim() || operatorReason.trim().length < 10 || operatorEvidence.trim().length < 10) return { status: "unsafe" as const, reason: "Operator identity, reason, and evidence are required" };
  const run = async (tx: PrismaTransaction) => {
    const row = await tx.storageUpload.findFirst({ where: { id, userId, objectKey, uploadId, completionState: "intervention", completionRevision: expectedRevision, completionInterventionAt: expectedInterventionAt } } as never);
    if (!row) return { status: "conflict" as const };
    if (row.uploadId) {
      const delayedUntil = new Date(now.getTime() + 15 * 60_000);
      const existingMultipart = await tx.storageMultipartCleanup.findFirst({ where: { objectKey: row.objectKey, uploadId: row.uploadId } } as never);
      if (existingMultipart?.leaseToken && existingMultipart.notBefore.getTime() > now.getTime()) throw new Error("Multipart cleanup is currently leased");
      if (existingMultipart?.status === "terminal") {
        // An operator-terminalized handle is already settled; never resurrect
        // its multipart outbox. The object cleanup below still gets a grace
        // period so a late provider commit can be collected safely.
      } else if (existingMultipart?.status === "intervention") {
        throw new Error("Multipart cleanup requires operator intervention");
      } else if (existingMultipart) {
        const adjusted = await tx.storageMultipartCleanup.updateMany({ where: { objectKey: row.objectKey, uploadId: row.uploadId, revision: existingMultipart.revision, leaseToken: existingMultipart.leaseToken, notBefore: existingMultipart.notBefore, status: existingMultipart.status }, data: { leaseToken: null, status: "pending", notBefore: existingMultipart.notBefore.getTime() > delayedUntil.getTime() ? existingMultipart.notBefore : delayedUntil, revision: { increment: 1 } } } as never);
        if (adjusted.count !== 1) throw new Error("Multipart cleanup changed during terminalization");
      } else {
        const createdMultipart = await tx.storageMultipartCleanup.createMany({ data: [{ objectKey: row.objectKey, uploadId: row.uploadId, leaseToken: null, notBefore: delayedUntil, attempts: 0, lastError: null, interventionAt: null, status: "pending", revision: 0 }], skipDuplicates: true } as never);
        const persistedMultipart = await tx.storageMultipartCleanup.findFirst({ where: { objectKey: row.objectKey, uploadId: row.uploadId } } as never);
        if (!persistedMultipart) throw new Error("Multipart cleanup was not durably persisted");
        if (createdMultipart.count === 0 && persistedMultipart.status !== "terminal" && (persistedMultipart.leaseToken !== null || !["pending", "retry"].includes(persistedMultipart.status) || persistedMultipart.notBefore.getTime() < delayedUntil.getTime())) throw new Error("Multipart cleanup changed during terminalization");
      }
      const existing = await tx.aiStorageCleanup.findFirst({ where: { objectKey: row.objectKey }, select: { leaseToken: true, notBefore: true } });
      if (existing) {
        if (existing.leaseToken && existing.notBefore.getTime() > now.getTime()) {
          throw new Error("Object cleanup is currently leased");
        }
        const adjustedObject = await tx.aiStorageCleanup.updateMany({ where: { objectKey: row.objectKey, leaseToken: existing.leaseToken, notBefore: existing.notBefore }, data: { leaseToken: null, state: "cleanup", notBefore: existing.notBefore.getTime() > delayedUntil.getTime() ? existing.notBefore : delayedUntil } });
        if (adjustedObject.count !== 1) throw new Error("Object cleanup changed during terminalization");
      } else {
        const createdObject = await tx.aiStorageCleanup.createMany({ data: [{ objectKey: row.objectKey, aiJobId: null, leaseToken: null, state: "cleanup", notBefore: delayedUntil }], skipDuplicates: true });
        const persisted = await tx.aiStorageCleanup.findFirst({ where: { objectKey: row.objectKey } });
        if (!persisted || persisted.notBefore.getTime() < delayedUntil.getTime() || (createdObject.count === 0 && (persisted.leaseToken !== null || persisted.state !== "cleanup"))) throw new Error("Object cleanup changed during terminalization");
      }
      const persistedObjectCleanup = await tx.aiStorageCleanup.findFirst({ where: { objectKey: row.objectKey } });
      if (!persistedObjectCleanup || persistedObjectCleanup.notBefore.getTime() < delayedUntil.getTime()) throw new Error("Object cleanup was not durably persisted");
    } else {
      const delayedUntil = new Date(now.getTime() + 15 * 60_000);
      const createdObject = await tx.aiStorageCleanup.createMany({ data: [{ objectKey: row.objectKey, aiJobId: null, leaseToken: null, state: "cleanup", notBefore: delayedUntil }], skipDuplicates: true });
      const persisted = await tx.aiStorageCleanup.findFirst({ where: { objectKey: row.objectKey } });
      if (!persisted || persisted.notBefore.getTime() < delayedUntil.getTime() || (createdObject.count === 0 && (persisted.leaseToken !== null || persisted.state !== "cleanup"))) throw new Error("Object cleanup changed during terminalization");
    }
    const removed = await tx.storageUpload.deleteMany({ where: { id, userId, objectKey, uploadId, completionState: "intervention", completionRevision: expectedRevision, completionInterventionAt: expectedInterventionAt } } as never);
    if (removed.count !== 1) throw new Error("Storage upload changed during terminalization");
    return { status: "terminalized" as const, revision: expectedRevision + 1 };
  };
  return prisma ? run(prisma) : startRetryableTransaction(run);
}

/** Record a remote handle after the creator's leased attach did not return success. */
export async function recordStorageUploadRemoteAfterAttachFailure({
  id,
  userId,
  uploadId,
  expected,
  prisma,
}: {
  id: string;
  userId: string;
  uploadId: string;
  expected: StorageUploadGenerationExpectation & {
    uploadId: null;
    startState: "creating";
  };
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? (await getDb());
  const result = await db.storageUpload.updateMany({
    where: {
      id,
      userId,
      uploadId: null,
      completedFileId: null,
      abandonedAt: null,
      createdAt: expected.createdAt,
      objectKey: expected.objectKey,
      name: expected.name,
      mimeType: expected.mimeType,
      size: expected.size,
      partSize: expected.partSize,
      startState: "creating",
      creationLeaseUntil: expected.creationLeaseUntil,
      creationLeaseToken: expected.creationLeaseToken,
      completionState: expected.completionState,
      completionLeaseUntil: expected.completionLeaseUntil,
      completionLeaseToken: expected.completionLeaseToken,
      completionRevision: expected.completionRevision,
      completionRetryNotBefore: expected.completionRetryNotBefore,
      ...(expected.unknownProbeLeaseToken !== undefined
        ? {
            unknownProbeNotBefore: expected.unknownProbeNotBefore,
            unknownProbeLeaseToken: expected.unknownProbeLeaseToken,
          }
        : {}),
      cleanupLeaseUntil: null,
      cleanupLeaseToken: null,
    },
    data: {
      uploadId,
      startState: "active",
      creationLeaseUntil: null,
      creationLeaseToken: null,
    },
  } as never);
  return result.count > 0;
}

/** Return an unknown-outcome create to the retryable intent state. */
export async function releaseStorageUploadCreation({
  id,
  now,
  leaseToken,
  prisma,
}: {
  id: string;
  now: Date;
  leaseToken: string | null;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? (await getDb());
  const result = await db.storageUpload.updateMany({
    where: {
      id,
      uploadId: null,
      startState: "creating",
      creationLeaseUntil: { lte: now },
      creationLeaseToken: leaseToken,
    },
    data: { startState: "intent", creationLeaseUntil: null, creationLeaseToken: null },
  });
  return result.count > 0;
}

// An upload is only ever reached through its own id together with the user it
// belongs to: the bucket would take parts from anyone who knew the key and the
// upload id, so those are never what a request is trusted on.
export async function findStorageUploadByIdAndUserId({
  id,
  userId,
  prisma,
}: {
  id: string;
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return withCompletionFields(
    await db.storageUpload.findFirst({ where: { id, userId } }),
  );
}

export async function deleteStorageUpload({
  id,
  prisma,
}: {
  id: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  await db.storageUpload.deleteMany({ where: { id } });
}

/** Delete only the exact row snapshot already frozen for remote cleanup. */
export async function deleteClaimedStorageUpload({
  id,
  userId,
  expected,
  prisma,
}: {
  id: string;
  userId: string;
  expected: StorageUploadAbandonExpectation & { abandonedAt: Date };
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? await getDb();
  const deleted = await db.storageUpload.deleteMany({
    where: {
      id,
      userId,
      completedFileId: null,
      abandonedAt: expected.abandonedAt,
      createdAt: expected.createdAt,
      objectKey: expected.objectKey,
      uploadId: expected.uploadId,
      name: expected.name,
      mimeType: expected.mimeType,
      size: expected.size,
      partSize: expected.partSize,
      startState: expected.startState,
      creationLeaseUntil: expected.creationLeaseUntil,
      creationLeaseToken: expected.creationLeaseToken,
      completionState: expected.completionState,
      completionLeaseUntil: expected.completionLeaseUntil,
      completionLeaseToken: expected.completionLeaseToken,
      completionRevision: expected.completionRevision,
      completionRetryNotBefore: expected.completionRetryNotBefore,
      cleanupLeaseUntil: expected.cleanupLeaseUntil,
      cleanupLeaseToken: expected.cleanupLeaseToken,
    },
  } as never);
  return deleted.count === 1;
}

/**
 * Replace a terminal multipart handle with a delayed object cleanup, then drop
 * only that claimed upload generation. The transaction closes the interval in
 * which an in-flight complete could otherwise publish after all tracking was
 * removed.
 */
export async function settleTerminalClaimedStorageUpload({
  id,
  userId,
  expected,
  now,
  objectCleanupNotBefore,
  prisma,
}: {
  id: string;
  userId: string;
  expected: StorageUploadAbandonExpectation & { abandonedAt: Date };
  now: Date;
  objectCleanupNotBefore: Date;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  if (objectCleanupNotBefore.getTime() <= now.getTime()) {
    throw new RangeError("Terminal multipart object cleanup must be delayed");
  }

  const run = async (tx: PrismaTransaction): Promise<boolean> => {
    await tx.aiStorageCleanup.createMany({
      data: [{
        objectKey: expected.objectKey,
        aiJobId: null,
        leaseToken: null,
        state: "cleanup",
        notBefore: objectCleanupNotBefore,
      }],
      skipDuplicates: true,
    });
    const cleanup = await tx.aiStorageCleanup.findFirst({
      where: { objectKey: expected.objectKey },
      select: {
        objectKey: true,
        leaseToken: true,
        notBefore: true,
      },
    });
    if (!cleanup) {
      throw new Error(
        `Object cleanup ${expected.objectKey} was not persisted`,
      );
    }
    if (
      cleanup.leaseToken &&
      cleanup.notBefore.getTime() > now.getTime()
    ) return false;

    const delayedUntil = cleanup.notBefore.getTime() >
        objectCleanupNotBefore.getTime()
      ? cleanup.notBefore
      : objectCleanupNotBefore;
    const delayed = await tx.aiStorageCleanup.updateMany({
      where: {
        objectKey: expected.objectKey,
        leaseToken: cleanup.leaseToken,
        notBefore: cleanup.notBefore,
      },
      data: {
        aiJobId: null,
        leaseToken: null,
        state: "cleanup",
        notBefore: delayedUntil,
      },
    });
    if (delayed.count !== 1) {
      throw new Error(
        `Object cleanup ${expected.objectKey} changed before it was delayed`,
      );
    }

    const deleted = await tx.storageUpload.deleteMany({
      where: {
        id,
        userId,
        completedFileId: null,
        abandonedAt: expected.abandonedAt,
        createdAt: expected.createdAt,
        objectKey: expected.objectKey,
        uploadId: expected.uploadId,
        name: expected.name,
        mimeType: expected.mimeType,
        size: expected.size,
        partSize: expected.partSize,
        startState: expected.startState,
        creationLeaseUntil: expected.creationLeaseUntil,
        creationLeaseToken: expected.creationLeaseToken,
        completionState: expected.completionState,
        completionLeaseUntil: expected.completionLeaseUntil,
        completionLeaseToken: expected.completionLeaseToken,
        completionRevision: expected.completionRevision,
        completionRetryNotBefore: expected.completionRetryNotBefore,
        cleanupLeaseUntil: expected.cleanupLeaseUntil,
        cleanupLeaseToken: expected.cleanupLeaseToken,
      },
    } as never);
    if (deleted.count !== 1) {
      // Roll back the newly-created cleanup as well. It may target a key now
      // owned by a replacement generation only in legacy deterministic rows.
      throw new Error(`Claimed storage upload ${id} changed before settlement`);
    }
    return true;
  };

  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

// 完了したアップロードの控えを残す。行ごと消すと、完了応答だけが失われたときに
// 同じ id で結果を取り直せず、やり直しが二重ファイルになる。
//
// 掃除に取られた行には書けない。取られたということは、そのオブジェクトはもう
// 捨てられる——控えを書いてしまうと、File が消えたオブジェクトを指す。書けたか
// どうかを返すので、呼び出し側はその場合に自分が組み上げたオブジェクトを片付け
// られる。
export async function markStorageUploadCompleted({
  id,
  userId,
  fileId,
  expected,
  prisma,
}: {
  id: string;
  userId: string;
  fileId: string;
  expected: StorageUploadGenerationExpectation;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? (await getDb());
  const result = await db.storageUpload.updateMany({
    where: {
      id,
      userId,
      completedFileId: null,
      abandonedAt: null,
      createdAt: expected.createdAt,
      objectKey: expected.objectKey,
      uploadId: expected.uploadId,
      name: expected.name,
      mimeType: expected.mimeType,
      size: expected.size,
      partSize: expected.partSize,
      startState: expected.startState,
      creationLeaseUntil: expected.creationLeaseUntil,
      creationLeaseToken: expected.creationLeaseToken,
      completionState: expected.completionState,
      completionLeaseUntil: expected.completionLeaseUntil,
      completionLeaseToken: expected.completionLeaseToken,
      completionRevision: expected.completionRevision,
      completionRetryNotBefore: expected.completionRetryNotBefore,
      ...(expected.unknownProbeLeaseToken !== undefined
        ? {
            unknownProbeNotBefore: expected.unknownProbeNotBefore,
            unknownProbeLeaseToken: expected.unknownProbeLeaseToken,
          }
        : {}),
      cleanupLeaseUntil: null,
      cleanupLeaseToken: null,
    },
    data: {
      completedFileId: fileId,
      completionState: "settled",
      completionLeaseUntil: null,
      completionLeaseToken: null,
      completionInterventionAt: null,
      completionRetryNotBefore: null,
      unknownProbeNotBefore: null,
      unknownProbeLeaseToken: null,
    },
  } as never);
  return result.count > 0;
}

export type StorageUploadGenerationExpectation = {
  createdAt: Date;
  objectKey: string;
  uploadId: string | null;
  name: string;
  mimeType: string;
  size: bigint;
  partSize: number;
  startState: string;
  creationLeaseUntil: Date | null;
  creationLeaseToken: string | null;
  completionState: string;
  completionLeaseUntil: Date | null;
  completionLeaseToken: string | null;
  completionRevision: number;
  completionRetryNotBefore: Date | null;
  unknownProbeNotBefore?: Date | null;
  unknownProbeLeaseToken?: string | null;
  reservationKind?: "multipart" | "dedicated";
};

// 「この行のパートは自分が捨てる」と宣言する。完了済みでも、既に誰かが宣言して
// いても取れない。取れた行にはもう控えを書けないので、そのあとで中止しても
// オブジェクトを消しても、File がそれを指すことはない。
export type StorageUploadAbandonExpectation =
  StorageUploadGenerationExpectation & {
    abandonedAt: Date | null;
    cleanupLeaseUntil: Date | null;
    cleanupLeaseToken: string | null;
  };

export async function claimStorageUploadForAbandon({
  id,
  userId,
  now,
  expected,
  cleanupLeaseToken,
  cleanupLeaseUntil,
  completionOwnerToken,
  requireExpiredCreationLease = false,
  prisma,
}: {
  id: string;
  userId: string;
  now: Date;
  expected: StorageUploadAbandonExpectation;
  cleanupLeaseToken: string;
  cleanupLeaseUntil: Date;
  completionOwnerToken?: string;
  requireExpiredCreationLease?: boolean;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  if (
    cleanupLeaseToken.length === 0 ||
    cleanupLeaseUntil.getTime() <= now.getTime()
  ) {
    throw new RangeError("Storage cleanup lease must expire in the future");
  }
  if (
    completionOwnerToken !== undefined &&
    (
      completionOwnerToken.length === 0 ||
      expected.completionState !== "completing" ||
      expected.completionLeaseToken !== completionOwnerToken
    )
  ) {
    throw new RangeError("Storage completion owner handoff is invalid");
  }
  // A stale sweep or account deletion can never take over an in-flight
  // completion merely because its lease elapsed. Only the completion owner
  // that observed a provider outcome may hand its fence to cleanup.
  if (expected.reservationKind === "dedicated") return false;
  if (completionOwnerToken === undefined && ["completing", "retry", "resumed", "intervention", "unknown"].includes(expected.completionState)) {
    return false;
  }
  const db = prisma ?? (await getDb());
  const result = await db.storageUpload.updateMany({
    where: {
      id,
      userId,
      completedFileId: null,
      abandonedAt: expected.abandonedAt,
      createdAt: expected.createdAt,
      objectKey: expected.objectKey,
      uploadId: expected.uploadId,
      name: expected.name,
      mimeType: expected.mimeType,
      size: expected.size,
      partSize: expected.partSize,
      startState: expected.startState,
      creationLeaseUntil: expected.creationLeaseUntil,
      creationLeaseToken: expected.creationLeaseToken,
      completionState: expected.completionState,
      completionLeaseUntil: expected.completionLeaseUntil,
      completionLeaseToken: expected.completionLeaseToken,
      completionRevision: expected.completionRevision,
      completionRetryNotBefore: expected.completionRetryNotBefore,
      cleanupLeaseUntil: expected.cleanupLeaseUntil,
      cleanupLeaseToken: expected.cleanupLeaseToken,
      AND: [
        {
          OR: [
            { cleanupLeaseToken: null, cleanupLeaseUntil: null },
            { cleanupLeaseUntil: { lte: now } },
          ],
        },
        ...(completionOwnerToken === undefined
          ? [{ completionState: { not: "completing" } }]
          : []),
        ...(requireExpiredCreationLease
          ? [{
              OR: [
                { creationLeaseUntil: null },
                { creationLeaseUntil: { lte: now } },
              ],
            }]
          : []),
      ],
    },
    data: {
      abandonedAt: expected.abandonedAt ?? now,
      cleanupLeaseToken,
      cleanupLeaseUntil,
      ...(completionOwnerToken === undefined
        ? {}
        : {
            completionState: "idle",
            completionLeaseUntil: null,
            completionLeaseToken: null,
            completionRetryNotBefore: null,
          }),
    },
  } as never);
  return result.count > 0;
}

/** Freeze an upload for an account cascade without claiming remote cleanup. */
export async function freezeStorageUploadForAccountDeletion({
  id,
  userId,
  now,
  expected,
  prisma,
}: {
  id: string;
  userId: string;
  now: Date;
  expected: StorageUploadAbandonExpectation & { abandonedAt: null };
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  if (expected.reservationKind === "dedicated") {
    if (
      expected.creationLeaseUntil !== null &&
      expected.creationLeaseUntil.getTime() > now.getTime()
    ) return false;
  } else if (["completing", "retry", "resumed", "intervention", "unknown"].includes(expected.completionState)) {
    return false;
  }
  const run = async (tx: PrismaTransaction) => {
  const frozen = await tx.storageUpload.updateMany({
    where: {
      id,
      userId,
      completedFileId: null,
      abandonedAt: null,
      createdAt: expected.createdAt,
      objectKey: expected.objectKey,
      uploadId: expected.uploadId,
      name: expected.name,
      mimeType: expected.mimeType,
      size: expected.size,
      partSize: expected.partSize,
      startState: expected.startState,
      creationLeaseUntil: expected.creationLeaseUntil,
      creationLeaseToken: expected.creationLeaseToken,
      completionState: expected.completionState,
      completionLeaseUntil: expected.completionLeaseUntil,
      completionLeaseToken: expected.completionLeaseToken,
      completionRevision: expected.completionRevision,
      completionRetryNotBefore: expected.completionRetryNotBefore,
      ...(expected.reservationKind === undefined
        ? {}
        : { reservationKind: expected.reservationKind }),
      cleanupLeaseUntil: null,
      cleanupLeaseToken: null,
      ...(expected.reservationKind === "dedicated"
        ? {}
        : { NOT: { completionState: "completing" } }),
    },
    data: {
      abandonedAt: now,
      ...(expected.reservationKind === "dedicated"
        ? {
            completionState: "idle",
            completionInterventionAt: null,
            creationLeaseUntil: null,
            creationLeaseToken: null,
            completionLeaseUntil: null,
            completionLeaseToken: null,
          }
        : {}),
    },
  } as never);
  if (frozen.count !== 1) return false;
  if (expected.reservationKind === "dedicated") {
    const delayedUntil = new Date(
      now.getTime() + DEDICATED_STORAGE_LATE_PUT_GRACE_MILLISECONDS,
    );
    const existing = await tx.aiStorageCleanup.findFirst({
      where: { objectKey: expected.objectKey },
      select: { leaseToken: true, notBefore: true },
    } as never);
    if (existing?.leaseToken) {
      throw new Error("Dedicated storage cleanup is currently leased");
    }
    if (existing) {
      const adjusted = await tx.aiStorageCleanup.updateMany({
        where: {
          objectKey: expected.objectKey,
          leaseToken: null,
          notBefore: existing.notBefore,
        },
        data: {
          aiJobId: null,
          state: "cleanup",
          notBefore: existing.notBefore.getTime() > delayedUntil.getTime()
            ? existing.notBefore
            : delayedUntil,
        },
      } as never);
      if (adjusted.count !== 1) {
        throw new Error("Dedicated storage cleanup changed during freeze");
      }
    } else {
      await tx.aiStorageCleanup.create({
        data: {
          objectKey: expected.objectKey,
          aiJobId: null,
          leaseToken: null,
          state: "cleanup",
          notBefore: delayedUntil,
        },
      } as never);
    }
  }
  return true;
  };
  return prisma ? run(prisma) : startRetryableTransaction(run);
}

// 取り消しの墓標の数。まだ現れていない名前の取り消しを書き留めたもので、
// 抱えているものは無い——だからこそ、いくらでも置けてしまってはいけない。
export async function countStorageUploadTombstonesByUserId({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}): Promise<number> {
  const db = prisma ?? (await getDb());
  return await db.storageUpload.count({
    where: { userId, uploadId: "", abandonedAt: { not: null } },
  });
}

// まだ終わっていないアップロードの本数。完了済みの控えは数えない——パートは
// もう無く、抱えているものが無いので。
export async function countStorageUploadsByUserId({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  // 掃除に取られた行は数えない。ここで限っているのは「同時に走らせてよい本数」
  // で、取られた行はもう利用者のものではない——中止に失敗しているあいだ、その分
  // の容量は下の合計に出る。ここで数えると、片付けに失敗しているあいだ新しい
  // アップロードを始められなくなる。
  return await db.storageUpload.count({
    where: { userId, completedFileId: null, abandonedAt: null },
  });
}

// What a browser started and never finished, plus anything already claimed for
// clearing.
//
// A claimed row is one somebody already decided to destroy and could not — the
// bucket would not let go of the parts. Making it wait out the same day as an
// upload nobody has touched leaves that storage paid for, and the account's
// quota spent, for no reason: it is due now.
export async function listStorageUploadsStartedBefore({
  before,
  now,
  limit,
  prisma,
}: {
  before: Date;
  now: Date;
  limit: number;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  const rows = await db.storageUpload.findMany({
    where: {
      AND: [
        {
          OR: [
            { completedFileId: null, createdAt: { lt: before } },
            { abandonedAt: { not: null } },
          ],
        },
        {
          OR: [
            { cleanupLeaseUntil: null },
            { cleanupLeaseUntil: { lte: now } },
          ],
        },
        {
          OR: [
            { creationLeaseUntil: null },
            { creationLeaseUntil: { lte: now } },
          ],
        },
        { completionState: { not: "completing" } },
        { completionState: { not: "retry" } },
        { completionState: { not: "resumed" } },
        { completionState: { not: "intervention" } },
        { completionState: { not: "unknown" } },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  } as never);
  return rows.map((row) => withCompletionFields(row)!);
}

// How much of the quota the uploads in progress have already spoken for. Two
// uploads started at once would each see only what is already stored, and
// together they could pass the quota; counting what is under way stops that.
export async function sumStorageUploadSizeByUserId({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  const result = await db.storageUpload.aggregate({
    // 完了済みの控えの分は File 側に移っているので、ここで数えると二重になる。
    // 掃除に取られた行は数える——宣言しただけで、中止に失敗しているあいだその
    // パートはバケットに残っている。数えなければ、実際の使用量が枠の外に出る。
    where: { userId, completedFileId: null },
    _sum: { size: true },
  });
  return result._sum.size ?? BigInt(0);
}
