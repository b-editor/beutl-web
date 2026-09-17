import type { Prisma } from "@prisma/client";
import { getDb } from "./provider";
import { startRetryableTransaction, type PrismaTransaction } from "./transaction";

export const STORAGE_ENTRY_FILE_SELECT = {
  id: true,
  name: true,
  folderId: true,
  size: true,
  mimeType: true,
  visibility: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.FileSelect;
export const STORAGE_ENTRY_FOLDER_SELECT = {
  id: true,
  name: true,
  parentId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.StorageFolderSelect;

export type StorageFilePatch = {
  name?: string;
  parentId?: string | null;
  visibility?: "PRIVATE" | "PUBLIC";
};
export type StorageFolderPatch = { name?: string; parentId?: string | null };
export type StorageEntryCursor = { kind: "folder" | "file"; name: string; id: string };

export async function storageFolderPath(
  userId: string,
  folderId: string | null,
  prisma?: PrismaTransaction,
) {
  if (folderId === null) return [];
  const db = prisma ?? (await getDb());
  type Folder = Prisma.StorageFolderGetPayload<{ select: typeof STORAGE_ENTRY_FOLDER_SELECT }>;
  // UNION deduplicates complete folder rows so corrupt cycles also terminate in SQL.
  // Both terms are owner-scoped; the path never traverses another user's folders.
  const folders = await db.$queryRaw<Folder[]>`
    WITH RECURSIVE "storage_folder_path" AS (
      SELECT "id", "name", "parentId", "createdAt", "updatedAt"
      FROM "StorageFolder"
      WHERE "id" = ${folderId} AND "userId" = ${userId}
      UNION
      SELECT parent."id", parent."name", parent."parentId", parent."createdAt", parent."updatedAt"
      FROM "StorageFolder" AS parent
      JOIN "storage_folder_path" AS child ON parent."id" = child."parentId"
      WHERE parent."userId" = ${userId}
    )
    SELECT "id", "name", "parentId", "createdAt", "updatedAt" FROM "storage_folder_path"
  `;
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const path: Folder[] = [];
  const visited = new Set<string>();
  let id: string | null = folderId;
  while (id !== null) {
    if (visited.has(id)) throw new Error("Cyclic storage folder hierarchy");
    visited.add(id);
    const folder = byId.get(id);
    if (!folder) return null;
    path.push(folder);
    id = folder.parentId;
  }
  return path.reverse();
}

// Keyset pagination uses the same (name, id) ordering and comparisons in the DB.
// Folders precede files; the cursor records which part of that ordering we reached.
export async function retrieveStorageEntries({
  userId,
  parentId,
  cursor,
  limit,
  foldersOnly = false,
}: {
  userId: string;
  parentId: string | null;
  cursor: StorageEntryCursor | null;
  limit: number;
  foldersOnly?: boolean;
}) {
  const db = await getDb();
  const path = await storageFolderPath(userId, parentId, db);
  if (!path) return { kind: "notFound" as const };
  const after = cursor
    ? { OR: [{ name: { gt: cursor.name } }, { name: cursor.name, id: { gt: cursor.id } }] }
    : {};
  const folders =
    cursor?.kind === "file"
      ? []
      : await db.storageFolder.findMany({
          where: { userId, parentId, ...after },
          select: STORAGE_ENTRY_FOLDER_SELECT,
          orderBy: [{ name: "asc" }, { id: "asc" }],
          take: limit + 1,
        });
  const files =
    foldersOnly || folders.length > limit
      ? []
      : await db.file.findMany({
          where: {
            userId,
            folderId: parentId,
            aiJobResult: null,
            ...(cursor?.kind === "file" ? after : {}),
          },
          select: STORAGE_ENTRY_FILE_SELECT,
          orderBy: [{ name: "asc" }, { id: "asc" }],
          take: limit + 1 - folders.length,
        });
  const entries = [
    ...folders.map((folder) => ({ kind: "folder" as const, ...folder })),
    ...files.map(({ folderId, ...file }) => ({
      kind: "file" as const,
      ...file,
      parentId: folderId,
    })),
  ];
  return {
    kind: "found" as const,
    path,
    entries: entries.slice(0, limit),
    hasMore: entries.length > limit,
  };
}

export async function updateOwnedStorageFiles(
  userId: string,
  ids: string[],
  patch: StorageFilePatch,
) {
  return startRetryableTransaction(
    async (tx) => {
      const where = { id: { in: ids }, userId, aiJobResult: null };
      const files = await tx.file.findMany({ where, select: { id: true, visibility: true } });
      if (!ids.length || files.length !== ids.length) return { kind: "notFound" as const };
      const restricted = patch.name !== undefined || patch.visibility !== undefined;
      if (restricted && files.some((file) => file.visibility === "DEDICATED"))
        return { kind: "inUse" as const };
      if (
        patch.parentId != null &&
        !(await tx.storageFolder.count({ where: { id: patch.parentId, userId } }))
      )
        return { kind: "targetNotFound" as const };
      const updated = await tx.file.updateMany({
        where: { ...where, ...(restricted ? { visibility: { not: "DEDICATED" as const } } : {}) },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
          ...(patch.parentId !== undefined ? { folderId: patch.parentId } : {}),
        },
      });
      if (updated.count !== ids.length) throw new Error("Storage files changed during update");
      return { kind: "updated" as const, count: updated.count };
    },
    { isolationLevel: "Serializable" },
  );
}

export async function updateOwnedStorageFolder(
  userId: string,
  id: string,
  patch: StorageFolderPatch,
) {
  return startRetryableTransaction(
    async (tx) => {
      if (!(await tx.storageFolder.count({ where: { id, userId } })))
        return { kind: "notFound" as const };
      if (patch.parentId != null) {
        const path = await storageFolderPath(userId, patch.parentId, tx);
        if (!path) return { kind: "targetNotFound" as const };
        if (path.some((folder) => folder.id === id)) return { kind: "intoItself" as const };
      }
      const updated = await tx.storageFolder.updateMany({ where: { id, userId }, data: patch });
      return { kind: updated.count === 1 ? ("updated" as const) : ("notFound" as const) };
    },
    { isolationLevel: "Serializable" },
  );
}

export async function storageFolderSummary(userId: string, id: string) {
  const db = await getDb();
  const path = await storageFolderPath(userId, id, db);
  if (!path?.length) return null;
  const ids = new Set([id]);
  let frontier = [id];
  while (frontier.length) {
    const children = await db.storageFolder.findMany({
      where: { userId, parentId: { in: frontier } },
      select: { id: true },
    });
    frontier = children.map((folder) => folder.id).filter((child) => !ids.has(child));
    for (const child of frontier) ids.add(child);
  }
  const fileCount = await db.file.count({
    where: { userId, aiJobResult: null, folderId: { in: [...ids] } },
  });
  return {
    folder: path[path.length - 1],
    ancestors: path.slice(0, -1),
    folderCount: ids.size - 1,
    fileCount,
  };
}

export async function moveOwnedStorageEntries(
  userId: string,
  entries: { id: string; kind: "file" | "folder" }[],
  parentId: string | null,
) {
  return startRetryableTransaction(
    async (tx) => {
      const path = await storageFolderPath(userId, parentId, tx);
      if (!path) return { kind: "targetNotFound" as const };
      const fileIds = entries.filter((x) => x.kind === "file").map((x) => x.id);
      const folderIds = entries.filter((x) => x.kind === "folder").map((x) => x.id);
      if (path.some((x) => folderIds.includes(x.id))) return { kind: "intoItself" as const };
      const files = { id: { in: fileIds }, userId, aiJobResult: null } as const;
      const folders = { id: { in: folderIds }, userId };
      if ((await tx.file.count({ where: files })) !== fileIds.length)
        return { kind: "fileNotFound" as const };
      if ((await tx.storageFolder.count({ where: folders })) !== folderIds.length)
        return { kind: "folderNotFound" as const };
      const movedFiles = fileIds.length
        ? await tx.file.updateMany({ where: files, data: { folderId: parentId } })
        : { count: 0 };
      const movedFolders = folderIds.length
        ? await tx.storageFolder.updateMany({ where: folders, data: { parentId } })
        : { count: 0 };
      if (movedFiles.count + movedFolders.count !== entries.length)
        throw new Error("Storage entries changed during move");
      return { kind: "moved" as const, count: entries.length };
    },
    { isolationLevel: "Serializable" },
  );
}
