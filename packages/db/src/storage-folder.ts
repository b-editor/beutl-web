import { getDb } from "./provider";
import { startRetryableTransaction, type PrismaTransaction } from "./transaction";
import { deleteUserFilesWithStorageCleanup } from "./file";

export type StorageFolderRecord = {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: Date;
};

export async function retrieveStorageFoldersByUserId({
  userId,
  prisma,
}: {
  userId?: string;
  prisma?: PrismaTransaction;
}): Promise<StorageFolderRecord[]> {
  if (!userId) return [];
  const db = prisma ?? await getDb();
  return await db.storageFolder.findMany({
    where: { userId },
    select: { id: true, name: true, parentId: true, createdAt: true },
    orderBy: { name: "asc" },
  });
}

async function folderBelongsToUser(
  tx: PrismaTransaction,
  folderId: string,
  userId: string,
): Promise<boolean> {
  return (await tx.storageFolder.count({ where: { id: folderId, userId } })) === 1;
}

// Whether a folder the client named is one of this user's. A write that lands
// a file in a folder asks before reserving anything, and again inside its own
// transaction, because the folder may go away in between.
export async function storageFolderBelongsToUser({
  folderId,
  userId,
  prisma,
}: {
  folderId: string;
  userId: string;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? await getDb();
  return await folderBelongsToUser(db, folderId, userId);
}

export async function createStorageFolder({
  userId,
  name,
  parentId,
  prisma,
}: {
  userId: string;
  name: string;
  parentId: string | null;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    if (parentId !== null && !(await folderBelongsToUser(tx, parentId, userId))) {
      return { kind: "parentNotFound" as const };
    }
    const created = await tx.storageFolder.create({
      data: { name, userId, parentId },
      select: { id: true },
    });
    return { kind: "created" as const, id: created.id };
  };
  return prisma ? run(prisma) : startRetryableTransaction(run);
}

export async function renameStorageFolder({
  folderId,
  userId,
  name,
  prisma,
}: {
  folderId: string;
  userId: string;
  name: string;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? await getDb();
  const result = await db.storageFolder.updateMany({
    where: { id: folderId, userId },
    data: { name },
  });
  return result.count === 1;
}

// The folder and every ancestor above it, nearest first. Null when the folder
// is not this user's. A cycle cannot be written through this module, but the
// walk still stops if it ever meets one.
async function folderChain(
  tx: PrismaTransaction,
  folderId: string,
  userId: string,
): Promise<string[] | null> {
  const chain: string[] = [];
  let current: string | null = folderId;
  while (current !== null && !chain.includes(current)) {
    chain.push(current);
    const row: { parentId: string | null } | null =
      await tx.storageFolder.findFirst({
        where: { id: current, userId },
        select: { parentId: true },
      });
    if (!row) return null;
    current = row.parentId;
  }
  return chain;
}

export async function moveStorageFolder({
  folderId,
  userId,
  parentId,
  prisma,
}: {
  folderId: string;
  userId: string;
  parentId: string | null;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    if (parentId !== null) {
      const chain = await folderChain(tx, parentId, userId);
      if (!chain) return { kind: "targetNotFound" as const };
      // Moving a folder under itself or under one of its descendants would
      // detach that subtree from the root.
      if (chain.includes(folderId)) return { kind: "intoItself" as const };
    }
    const result = await tx.storageFolder.updateMany({
      where: { id: folderId, userId },
      data: { parentId },
    });
    return result.count === 1
      ? { kind: "moved" as const }
      : { kind: "notFound" as const };
  };
  return prisma ? run(prisma) : startRetryableTransaction(run);
}

export async function moveStorageFiles({
  fileIds,
  userId,
  folderId,
  prisma,
}: {
  fileIds: string[];
  userId: string;
  folderId: string | null;
  prisma?: PrismaTransaction;
}) {
  const ids = [...new Set(fileIds)];
  const run = async (tx: PrismaTransaction) => {
    if (ids.length === 0) return { kind: "notFound" as const };
    if (folderId !== null && !(await folderBelongsToUser(tx, folderId, userId))) {
      return { kind: "targetNotFound" as const };
    }
    // All or nothing: a stray id in the request must not move the rest, or the
    // caller reports a failure while some files have already changed place.
    const where = { id: { in: ids }, userId, aiJobResult: null } as const;
    const found = await tx.file.count({ where });
    if (found !== ids.length) return { kind: "notFound" as const };
    await tx.file.updateMany({ where, data: { folderId } });
    return { kind: "moved" as const };
  };
  return prisma ? run(prisma) : startRetryableTransaction(run);
}

// The folder and everything below it, breadth first.
async function folderSubtree(
  tx: PrismaTransaction,
  folderId: string,
  userId: string,
): Promise<string[]> {
  const ids = [folderId];
  let frontier = [folderId];
  while (frontier.length > 0) {
    const children: { id: string }[] = await tx.storageFolder.findMany({
      where: { parentId: { in: frontier }, userId },
      select: { id: true },
    });
    frontier = children.map((child) => child.id).filter((id) => !ids.includes(id));
    ids.push(...frontier);
  }
  return ids;
}

// How many files one transaction of a folder deletion takes with it. A
// folder may hold as many files as the account is allowed, and one
// transaction over all of them would outgrow the statement and time limits.
export const STORAGE_FOLDER_DELETE_BATCH = 200;

// A file the bulk delete would refuse: dedicated, or still pointed at from a
// package, screenshot, profile, or release. The account drain skips the same
// files, leaving them to the User cascade.
export const FILE_IN_USE_WHERE = {
  OR: [
    { visibility: "DEDICATED" as const },
    { Package: { some: {} } },
    { PackageScreenshot: { some: {} } },
    { Profile: { some: {} } },
    { Release: { some: {} } },
  ],
};

// Deleting a folder deletes what is inside it, the way a desktop folder does.
// The files go through the same cleanup path as a bulk delete. An in-use file
// anywhere in the tree stops the whole operation before anything is lost:
// the tree is checked for one first, then the files go in bounded batches,
// each in its own transaction, and the folder row last. A file that comes
// into use between the check and its batch stops the deletion there; what
// was already deleted stays deleted, and deleting the folder again finishes
// the job once the file is released.
//
// Given a transaction, everything runs inside it, unbatched; only the
// screen's action, which passes none, deletes trees of any size.
export async function deleteStorageFolderTree({
  folderId,
  userId,
  prisma,
}: {
  folderId: string;
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const transact = <T>(run: (tx: PrismaTransaction) => Promise<T>): Promise<T> =>
    prisma ? run(prisma) : startRetryableTransaction(run);

  const preflight = await transact(async (tx) => {
    if (!(await folderBelongsToUser(tx, folderId, userId))) {
      return { kind: "notFound" as const };
    }
    const folderIds = await folderSubtree(tx, folderId, userId);
    const inUse = await tx.file.count({
      where: { folderId: { in: folderIds }, userId, aiJobResult: null, ...FILE_IN_USE_WHERE },
    });
    if (inUse > 0) return { kind: "inUse" as const };
    return { kind: "ready" as const };
  });
  if (preflight.kind !== "ready") return preflight;

  let fileCount = 0;
  for (;;) {
    const outcome = await transact(async (tx) => {
      // The tree is read again inside every batch, in the transaction that
      // deletes from it. A folder moved out of the tree while the deletion
      // runs is no longer part of it, so its files are left alone; one moved
      // in is picked up. Under serializable isolation a move committing
      // during a batch conflicts with that batch's read and one of the two
      // retries, so a batch never acts on a tree it did not see.
      if (!(await folderBelongsToUser(tx, folderId, userId))) {
        return { kind: "notFound" as const };
      }
      const folderIds = await folderSubtree(tx, folderId, userId);
      const batch: { id: string }[] = await tx.file.findMany({
        where: { folderId: { in: folderIds }, userId, aiJobResult: null },
        select: { id: true },
        orderBy: { id: "asc" },
        take: STORAGE_FOLDER_DELETE_BATCH,
      });
      if (batch.length === 0) return { kind: "drained" as const };
      const deleted = await deleteUserFilesWithStorageCleanup({
        fileIds: batch.map((file) => file.id),
        userId,
        prisma: tx,
      });
      return deleted.kind === "deleted"
        ? { kind: "deleted" as const, count: batch.length }
        : { kind: deleted.kind };
    });
    if (outcome.kind === "drained") break;
    if (outcome.kind !== "deleted") return { kind: outcome.kind };
    fileCount += outcome.count;
  }

  const folderCount = await transact(async (tx) => {
    const folderIds = await folderSubtree(tx, folderId, userId);
    // Child folders go with the parent through the cascade; a file that
    // arrived after the last batch is moved to the root by the same cascade.
    await tx.storageFolder.deleteMany({ where: { id: folderId, userId } });
    return folderIds.length;
  });
  return { kind: "deleted" as const, fileCount, folderCount };
}
