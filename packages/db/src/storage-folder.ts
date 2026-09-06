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
    const result = await tx.file.updateMany({
      where: { id: { in: ids }, userId, aiJobResult: null },
      data: { folderId },
    });
    return result.count === ids.length
      ? { kind: "moved" as const }
      : { kind: "notFound" as const };
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

// Deleting a folder deletes what is inside it, the way a desktop folder does.
// The files go through the same cleanup path as a bulk delete, so an in-use
// file anywhere in the tree stops the whole operation before anything is lost.
export async function deleteStorageFolderTree({
  folderId,
  userId,
  prisma,
}: {
  folderId: string;
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    if (!(await folderBelongsToUser(tx, folderId, userId))) {
      return { kind: "notFound" as const };
    }
    const folderIds = await folderSubtree(tx, folderId, userId);
    const files: { id: string }[] = await tx.file.findMany({
      where: { folderId: { in: folderIds }, userId, aiJobResult: null },
      select: { id: true },
    });
    if (files.length > 0) {
      const outcome = await deleteUserFilesWithStorageCleanup({
        fileIds: files.map((file) => file.id),
        userId,
        prisma: tx,
      });
      if (outcome.kind !== "deleted") return { kind: outcome.kind };
    }
    // Child folders go with the parent through the cascade.
    await tx.storageFolder.delete({ where: { id: folderId } });
    return {
      kind: "deleted" as const,
      fileCount: files.length,
      folderCount: folderIds.length,
    };
  };
  return prisma ? run(prisma) : startRetryableTransaction(run);
}
