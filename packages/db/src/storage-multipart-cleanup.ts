import { getDb } from "./provider";
import {
  startRetryableTransaction,
  type PrismaTransaction,
} from "./transaction";

export const STORAGE_MULTIPART_CLEANUP_LEASE_MILLISECONDS = 5 * 60 * 1000;
export const STORAGE_MULTIPART_SETTLEMENT_GRACE_MILLISECONDS = 15 * 60 * 1000;
export const STORAGE_MULTIPART_MAX_ATTEMPTS = 5;
const STORAGE_MULTIPART_CLEANUP_BATCH_SIZE = 500;

export type StorageMultipartCleanupSnapshot = {
  objectKey: string;
  uploadId: string;
  leaseToken: string | null;
  notBefore: Date;
  status?: string;
  attempts?: number;
  interventionAt?: Date | null;
  revision?: number;
  operatorUserId?: string | null;
  operatorReason?: string | null;
  operatorEvidence?: string | null;
  terminalizedAt?: Date | null;
};

export async function enqueueStorageMultipartCleanups({
  handles,
  notBefore = new Date(),
  prisma,
}: {
  handles: Array<{ objectKey: string; uploadId: string }>;
  notBefore?: Date;
  prisma?: PrismaTransaction;
}): Promise<number> {
  const unique = [
    ...new Map(
      handles
        .filter((handle) => handle.objectKey.length > 0 && handle.uploadId.length > 0)
        .map((handle) => [`${handle.objectKey}\0${handle.uploadId}`, handle]),
    ).values(),
  ];
  if (unique.length === 0) return 0;

  const db = prisma ?? await getDb();
  let created = 0;
  for (
    let offset = 0;
    offset < unique.length;
    offset += STORAGE_MULTIPART_CLEANUP_BATCH_SIZE
  ) {
    const result = await db.storageMultipartCleanup.createMany({
      data: unique
        .slice(offset, offset + STORAGE_MULTIPART_CLEANUP_BATCH_SIZE)
        .map((handle) => ({
          objectKey: handle.objectKey,
          uploadId: handle.uploadId,
          leaseToken: null,
          notBefore,
          attempts: 0,
          lastError: null,
          interventionAt: null,
          status: "pending",
          revision: 0,
        })),
      skipDuplicates: true,
    });
    created += result.count;
  }
  return created;
}

export async function enqueueStorageMultipartCleanup({
  objectKey,
  uploadId,
  notBefore = new Date(),
  prisma,
}: {
  objectKey: string;
  uploadId: string;
  notBefore?: Date;
  prisma?: PrismaTransaction;
}): Promise<void> {
  await enqueueStorageMultipartCleanups({
    handles: [{ objectKey, uploadId }],
    notBefore,
    prisma,
  });
}

export async function findStorageMultipartCleanup({
  objectKey,
  uploadId,
  prisma,
}: {
  objectKey: string;
  uploadId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.storageMultipartCleanup.findFirst({
    where: { objectKey, uploadId },
  });
}

export async function listDueStorageMultipartCleanups({
  now,
  limit = 100,
  prisma,
}: {
  now: Date;
  limit?: number;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.storageMultipartCleanup.findMany({
    where: { status: { in: ["pending", "retry", "processing"] }, notBefore: { lte: now } },
    orderBy: [{ notBefore: "asc" }, { createdAt: "asc" }],
    take: limit,
  });
}

export async function claimStorageMultipartCleanup({
  expected,
  now,
  prisma,
}: {
  expected: StorageMultipartCleanupSnapshot;
  now: Date;
  prisma?: PrismaTransaction;
}): Promise<(StorageMultipartCleanupSnapshot & { leaseToken: string }) | null> {
  const db = prisma ?? await getDb();
  const leaseToken = crypto.randomUUID();
  const notBefore = new Date(
    now.getTime() + STORAGE_MULTIPART_CLEANUP_LEASE_MILLISECONDS,
  );
  const claimed = await db.storageMultipartCleanup.updateMany({
    where: {
      objectKey: expected.objectKey,
      uploadId: expected.uploadId,
      leaseToken: expected.leaseToken,
      notBefore: expected.notBefore,
      status: { in: ["pending", "retry", "processing"] },
      OR: [{ leaseToken: expected.leaseToken }, { leaseToken: null }],
    },
    data: { leaseToken, notBefore, status: "processing", revision: { increment: 1 } },
  });
  if (claimed.count !== 1) return null;
  return {
    objectKey: expected.objectKey,
    uploadId: expected.uploadId,
    leaseToken,
    notBefore,
  };
}

export async function recordStorageMultipartCleanupFailure({
  objectKey, uploadId, leaseToken, now, error, maxAttempts = STORAGE_MULTIPART_MAX_ATTEMPTS, prisma,
}: { objectKey: string; uploadId: string; leaseToken: string; now: Date; error: string; maxAttempts?: number; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  const current = await db.storageMultipartCleanup.findFirst({ where: { objectKey, uploadId, leaseToken } });
  if (!current) return { status: "lost" as const };
  const attempts = current.attempts + 1;
  const intervene = attempts >= maxAttempts;
  const delay = Math.min(60 * 60 * 1000, STORAGE_MULTIPART_CLEANUP_LEASE_MILLISECONDS * 2 ** Math.min(attempts - 1, 8));
  const updated = await db.storageMultipartCleanup.updateMany({
    where: { objectKey, uploadId, leaseToken, revision: current.revision },
    data: {
      attempts,
      lastError: error.slice(0, 2000),
      status: intervene ? "intervention" : "retry",
      interventionAt: intervene ? now : null,
      leaseToken: null,
      notBefore: new Date(now.getTime() + delay),
      revision: { increment: 1 },
    },
  });
  return updated.count === 1 ? { status: intervene ? "intervention" as const : "retry" as const, attempts } : { status: "lost" as const };
}

export async function listStorageMultipartInterventions({ limit = 100, prisma }: { limit?: number; prisma?: PrismaTransaction } = {}) {
  const db = prisma ?? await getDb();
  return db.storageMultipartCleanup.findMany({ where: { status: "intervention" }, orderBy: [{ interventionAt: "asc" }, { createdAt: "asc" }], take: limit });
}

export async function resumeStorageMultipartIntervention({ objectKey, uploadId, expectedRevision, expectedInterventionAt, now, prisma }: { objectKey: string; uploadId: string; expectedRevision: number; expectedInterventionAt: Date; now: Date; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  const updated = await db.storageMultipartCleanup.updateMany({ where: { objectKey, uploadId, status: "intervention", revision: expectedRevision, interventionAt: expectedInterventionAt }, data: { status: "pending", interventionAt: null, lastError: null, leaseToken: null, notBefore: now, revision: { increment: 1 } } });
  return updated.count === 1 ? { status: "resumed" as const, revision: expectedRevision + 1 } : { status: "conflict" as const };
}

export async function terminalizeStorageMultipartIntervention({ objectKey, uploadId, expectedRevision, expectedInterventionAt, now, operatorUserId, operatorReason, operatorEvidence, prisma }: { objectKey: string; uploadId: string; expectedRevision: number; expectedInterventionAt: Date; now: Date; operatorUserId: string; operatorReason: string; operatorEvidence: string; prisma?: PrismaTransaction }) {
  if (!operatorUserId.trim() || !operatorReason.trim() || !operatorEvidence.trim()) {
    return { status: "unsafe" as const, reason: "Operator identity, reason, and evidence are required" };
  }
  const run = async (tx: PrismaTransaction) => {
    const row = await tx.storageMultipartCleanup.findFirst({ where: { objectKey, uploadId, status: "intervention", revision: expectedRevision, interventionAt: expectedInterventionAt } });
    if (!row) return { status: "conflict" as const };
    const updated = await tx.storageMultipartCleanup.updateMany({ where: { objectKey, uploadId, status: "intervention", revision: expectedRevision, interventionAt: expectedInterventionAt }, data: ({ status: "terminal", leaseToken: null, operatorUserId: operatorUserId.trim(), operatorReason: operatorReason.trim(), operatorEvidence: operatorEvidence.trim(), terminalizedAt: now, revision: { increment: 1 } } as never) });
    if (updated.count !== 1) return { status: "conflict" as const };
    const remaining = await tx.storageMultipartCleanup.count({ where: { objectKey, status: { in: ["pending", "processing", "retry", "intervention"] } } });
    if (remaining === 0) {
      const objectCleanup = await tx.aiStorageCleanup.findFirst({ where: { objectKey }, select: { leaseToken: true, notBefore: true } });
      if (objectCleanup) await tx.aiStorageCleanup.updateMany({ where: { objectKey, leaseToken: objectCleanup.leaseToken, notBefore: objectCleanup.notBefore }, data: { leaseToken: null, state: "cleanup", notBefore: new Date(Math.max(objectCleanup.notBefore.getTime(), now.getTime() + STORAGE_MULTIPART_SETTLEMENT_GRACE_MILLISECONDS)) } });
    }
    return { status: "terminalized" as const, operatorUserId: operatorUserId.trim(), operatorReason: operatorReason.trim(), operatorEvidence: operatorEvidence.trim(), terminalizedAt: now };
  };
  return prisma ? run(prisma) : startRetryableTransaction(run);
}

export async function finalizeStorageMultipartCleanup({
  objectKey,
  uploadId,
  leaseToken,
  now,
  prisma,
}: {
  objectKey: string;
  uploadId: string;
  leaseToken: string;
  now: Date;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const run = async (tx: PrismaTransaction): Promise<boolean> => {
    const claim = await tx.storageMultipartCleanup.findFirst({
      where: { objectKey, uploadId, leaseToken, status: "processing" },
      select: { objectKey: true },
    });
    if (!claim) return false;

    const objectCleanup = await tx.aiStorageCleanup.findFirst({
      where: { objectKey },
      select: { leaseToken: true, notBefore: true },
    });
    if (
      objectCleanup?.leaseToken &&
      objectCleanup.notBefore.getTime() > now.getTime()
    ) {
      // An object delete already owns the remote side effect. Keep this handle
      // row so its presence continues to gate deletion after that lease ends.
      throw new Error(
        `Object cleanup ${objectKey} is active while multipart cleanup is pending`,
      );
    }

    const deleted = await tx.storageMultipartCleanup.deleteMany({
      where: { objectKey, uploadId, leaseToken },
    });
    if (deleted.count !== 1) return false;

    const remaining = await tx.storageMultipartCleanup.count({
      where: { objectKey, status: { in: ["pending", "processing", "retry", "intervention"] } },
    });
    if (remaining > 0 || !objectCleanup) return true;

    const graceUntil = new Date(
      now.getTime() + STORAGE_MULTIPART_SETTLEMENT_GRACE_MILLISECONDS,
    );
    const postponed = await tx.aiStorageCleanup.updateMany({
      where: {
        objectKey,
        leaseToken: objectCleanup.leaseToken,
        notBefore: objectCleanup.notBefore,
      },
      data: {
        leaseToken: null,
        state: "cleanup",
        notBefore: objectCleanup.notBefore.getTime() > graceUntil.getTime()
          ? objectCleanup.notBefore
          : graceUntil,
      },
    });
    if (postponed.count !== 1) {
      throw new Error(
        `Object cleanup ${objectKey} could not be postponed after multipart settlement`,
      );
    }
    return true;
  };

  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}
