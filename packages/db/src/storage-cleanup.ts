import { getDb } from "./provider";
import {
  startRetryableTransaction,
  type PrismaTransaction,
} from "./transaction";

export const storageCleanupReasons = {
  pendingUpload: "PENDING_UPLOAD",
  pendingReference: "PENDING_REFERENCE",
  unreferencedFile: "UNREFERENCED_FILE",
  userDeletion: "USER_DELETION",
} as const;

const pendingUploadLifetimeMs = 24 * 60 * 60 * 1000;
const cleanupLeaseMs = 5 * 60 * 1000;

export class StorageCleanupConflictError extends Error {
  constructor() {
    super("The storage cleanup reservation is no longer available.");
    this.name = "StorageCleanupConflictError";
  }
}

type NewStorageFile = Readonly<{
  id: string;
  objectKey: string;
  name: string;
  size: number;
  mimeType: string;
  userId: string;
  visibility: "PUBLIC" | "PRIVATE" | "DEDICATED";
  sha256: string;
}>;

function hasNoFileReferences(file: {
  _count: {
    Package: number;
    PackageScreenshot: number;
    Profile: number;
    Release: number;
  };
}): boolean {
  return file._count.Package === 0 &&
    file._count.PackageScreenshot === 0 &&
    file._count.Profile === 0 &&
    file._count.Release === 0;
}

const fileReferenceCountSelect = {
  objectKey: true,
  _count: {
    select: {
      Package: true,
      PackageScreenshot: true,
      Profile: true,
      Release: true,
    },
  },
} as const;

async function upsertUnreferencedFileCleanup({
  file,
  prisma,
}: {
  file: { id: string; objectKey: string };
  prisma: PrismaTransaction;
}): Promise<void> {
  await prisma.storageCleanup.upsert({
    where: { objectKey: file.objectKey },
    create: {
      id: crypto.randomUUID(),
      fileId: file.id,
      objectKey: file.objectKey,
      reason: storageCleanupReasons.unreferencedFile,
      availableAt: new Date(),
    },
    update: {
      fileId: file.id,
      reason: storageCleanupReasons.unreferencedFile,
      availableAt: new Date(),
    },
  });
}

export async function reserveStorageUpload({
  id,
  fileId,
  objectKey,
  prisma,
}: {
  id: string;
  fileId: string;
  objectKey: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.storageCleanup.create({
    data: {
      id,
      fileId,
      objectKey,
      reason: storageCleanupReasons.pendingUpload,
      availableAt: new Date(Date.now() + pendingUploadLifetimeMs),
    },
  });
}

export async function finalizeStorageUpload({
  cleanupId,
  file,
  pendingReference,
  prisma,
}: {
  cleanupId: string;
  file: NewStorageFile;
  pendingReference: boolean;
  prisma?: PrismaTransaction;
}) {
  const finalize = async (tx: PrismaTransaction) => {
    const reserved = await tx.storageCleanup.updateMany({
      where: {
        id: cleanupId,
        fileId: file.id,
        objectKey: file.objectKey,
        leaseId: null,
      },
      data: pendingReference
        ? { reason: storageCleanupReasons.pendingReference }
        : { reason: storageCleanupReasons.pendingUpload },
    });
    if (reserved.count !== 1) {
      throw new StorageCleanupConflictError();
    }

    const record = await tx.file.create({ data: file });
    if (!pendingReference) {
      const removed = await tx.storageCleanup.deleteMany({
        where: { id: cleanupId, leaseId: null },
      });
      if (removed.count !== 1) {
        throw new StorageCleanupConflictError();
      }
    }
    return record;
  };

  return prisma
    ? await finalize(prisma)
    : await startRetryableTransaction(finalize);
}

/** Claims a dedicated upload inside the same transaction that adds its ref. */
export async function claimPendingStorageFileReference({
  fileId,
  prisma,
}: {
  fileId: string;
  prisma: PrismaTransaction;
}): Promise<void> {
  const removed = await prisma.storageCleanup.deleteMany({
    where: {
      fileId,
      reason: storageCleanupReasons.pendingReference,
      leaseId: null,
    },
  });
  if (removed.count !== 1) {
    throw new StorageCleanupConflictError();
  }
}

export async function markStorageCleanupReady({
  fileId,
  errorCode,
  prisma,
}: {
  fileId: string;
  errorCode?: string;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? await getDb();
  const result = await db.storageCleanup.updateMany({
    where: { fileId, leaseId: null },
    data: {
      availableAt: new Date(),
      lastErrorCode: errorCode,
    },
  });
  return result.count > 0;
}

export async function enqueueFileCleanupIfUnreferenced({
  fileId,
  prisma,
}: {
  fileId: string;
  prisma: PrismaTransaction;
}): Promise<boolean> {
  const file = await prisma.file.findUnique({
    where: { id: fileId },
    select: fileReferenceCountSelect,
  });
  if (!file || !hasNoFileReferences(file)) {
    return false;
  }

  await upsertUnreferencedFileCleanup({
    file: { id: fileId, objectKey: file.objectKey },
    prisma,
  });
  return true;
}

export async function enqueueFilesCleanup({
  fileIds,
}: {
  fileIds: readonly string[];
}): Promise<boolean> {
  const ids = [...new Set(fileIds)];
  if (ids.length === 0) return false;
  return await startRetryableTransaction(async (tx) => {
    const files = await tx.file.findMany({
      where: { id: { in: ids } },
      select: { id: true, ...fileReferenceCountSelect },
    });
    if (files.length !== ids.length || files.some((file) =>
      !hasNoFileReferences(file)
    )) {
      return false;
    }
    for (const file of files) {
      await upsertUnreferencedFileCleanup({ file, prisma: tx });
    }
    return true;
  });
}

export type ClaimedStorageCleanup = Readonly<{
  id: string;
  fileId: string | null;
  objectKey: string;
  leaseId: string;
}>;

export async function claimDueStorageCleanups({
  limit = 10,
  now = new Date(),
  prisma,
}: {
  limit?: number;
  now?: Date;
  prisma?: PrismaTransaction;
} = {}): Promise<ClaimedStorageCleanup[]> {
  const claim = async (tx: PrismaTransaction) => {
    const candidates = await tx.storageCleanup.findMany({
      where: {
        availableAt: { lte: now },
        OR: [
          { leaseId: null },
          { leaseExpiresAt: { lte: now } },
        ],
      },
      orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
      take: Math.max(1, Math.min(limit, 100)),
      select: { id: true, fileId: true, objectKey: true },
    });
    const claimed: ClaimedStorageCleanup[] = [];
    for (const candidate of candidates) {
      const leaseId = crypto.randomUUID();
      const updated = await tx.storageCleanup.updateMany({
        where: {
          id: candidate.id,
          availableAt: { lte: now },
          OR: [
            { leaseId: null },
            { leaseExpiresAt: { lte: now } },
          ],
        },
        data: {
          leaseId,
          leaseExpiresAt: new Date(now.getTime() + cleanupLeaseMs),
        },
      });
      if (updated.count === 1) {
        claimed.push({ ...candidate, leaseId });
      }
    }
    return claimed;
  };
  return prisma
    ? await claim(prisma)
    : await startRetryableTransaction(claim);
}

export async function countDueStorageCleanups({
  now = new Date(),
  prisma,
}: {
  now?: Date;
  prisma?: PrismaTransaction;
} = {}): Promise<number> {
  const db = prisma ?? await getDb();
  return await db.storageCleanup.count({
    where: { availableAt: { lte: now } },
  });
}

export async function storageCleanupHasReferences(
  cleanup: ClaimedStorageCleanup,
): Promise<boolean> {
  if (!cleanup.fileId) return false;
  const db = await getDb();
  const file = await db.file.findUnique({
    where: { id: cleanup.fileId },
    select: fileReferenceCountSelect,
  });
  return file ? !hasNoFileReferences(file) : false;
}

export async function cancelClaimedStorageCleanup(
  cleanup: ClaimedStorageCleanup,
): Promise<void> {
  const db = await getDb();
  await db.storageCleanup.deleteMany({
    where: { id: cleanup.id, leaseId: cleanup.leaseId },
  });
}

export async function completeClaimedStorageCleanup(
  cleanup: ClaimedStorageCleanup,
): Promise<void> {
  await startRetryableTransaction(async (tx) => {
    const reservation = await tx.storageCleanup.findFirst({
      where: { id: cleanup.id, leaseId: cleanup.leaseId },
      select: { id: true },
    });
    if (!reservation) return;

    if (cleanup.fileId) {
      const file = await tx.file.findUnique({
        where: { id: cleanup.fileId },
        select: fileReferenceCountSelect,
      });
      if (file) {
        if (!hasNoFileReferences(file)) {
          throw new StorageCleanupConflictError();
        }
        await tx.file.delete({ where: { id: cleanup.fileId } });
      }
    }
    await tx.storageCleanup.delete({ where: { id: cleanup.id } });
  });
}

export async function deferClaimedStorageCleanup({
  cleanup,
  errorCode,
}: {
  cleanup: ClaimedStorageCleanup;
  errorCode: string;
}): Promise<void> {
  const db = await getDb();
  const current = await db.storageCleanup.findFirst({
    where: { id: cleanup.id, leaseId: cleanup.leaseId },
    select: { attempts: true },
  });
  if (!current) return;
  const attempts = current.attempts + 1;
  const delayMs = Math.min(60 * 60 * 1000, 1000 * 2 ** Math.min(attempts, 10));
  await db.storageCleanup.updateMany({
    where: { id: cleanup.id, leaseId: cleanup.leaseId },
    data: {
      attempts: { increment: 1 },
      lastErrorCode: errorCode,
      availableAt: new Date(Date.now() + delayMs),
      leaseId: null,
      leaseExpiresAt: null,
    },
  });
}
