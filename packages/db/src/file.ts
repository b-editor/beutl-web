import {
  ARCHIVE_MIME_TYPES,
  DOCUMENT_MIME_TYPES,
  type FileKind,
  type StorageListingParams,
} from "@beutl/core";
import type { Prisma } from "@prisma/client";
import { getDb } from "./provider";
import { startRetryableTransaction, type PrismaTransaction } from "./transaction";

type FileReferenceSnapshot = {
  Package?: { id: string }[];
  PackageScreenshot?: { packageId: string }[];
  Profile?: { userId: string }[];
  Release?: { id: string }[];
  aiJobResult?: { id: string } | null;
};

function hasLiveFileReference(references: FileReferenceSnapshot | null): boolean {
  return Boolean(
    references &&
      ((references.Package?.length ?? 0) > 0 ||
        (references.PackageScreenshot?.length ?? 0) > 0 ||
        (references.Profile?.length ?? 0) > 0 ||
        (references.Release?.length ?? 0) > 0 ||
        references.aiJobResult),
  );
}

const fileReferenceSelect = {
  Package: { select: { id: true } },
  PackageScreenshot: { select: { packageId: true } },
  Profile: { select: { userId: true } },
  Release: { select: { id: true } },
  aiJobResult: { select: { id: true } },
} as const;

export async function findFileForContentAccess({
  id: fileId,
  prisma,
}: {
  id: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const file = await db.file.findFirst({
    where: {
      id: fileId,
    },
    select: {
      name: true,
      objectKey: true,
      visibility: true,
      userId: true,
      mimeType: true,
      Package: {
        select: {
          userId: true,
          published: true,
        },
      },
      Profile: true,
      PackageScreenshot: {
        select: {
          package: {
            select: {
              userId: true,
              published: true,
            },
          },
        },
      },
      Release: {
        select: {
          published: true,
          package: {
            select: {
              id: true,
              userId: true,
              published: true,
              packagePricing: {
                select: {
                  id: true,
                  price: true,
                },
              },
            },
          },
        },
      },
      aiJobResult: {
        select: { id: true },
      },
    },
  });
  if (file?.aiJobResult) {
    file.visibility = "PRIVATE";
  }
  return file;
}

export async function findFileForApi({
  id,
  prisma,
}: {
  id: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const file = await db.file.findFirst({
    where: {
      id: id,
    },
    select: {
      id: true,
      name: true,
      mimeType: true,
      userId: true,
      visibility: true,
      size: true,
      sha256: true,
      Package: {
        select: {
          userId: true,
          published: true,
        },
      },
      Profile: {
        select: {
          userId: true,
        },
      },
      PackageScreenshot: {
        select: {
          package: {
            select: {
              userId: true,
              published: true,
            },
          },
        },
      },
      Release: {
        select: {
          published: true,
          package: {
            select: {
              id: true,
              userId: true,
              published: true,
              packagePricing: {
                select: {
                  id: true,
                  price: true,
                },
              },
            },
          },
        },
      },
      aiJobResult: {
        select: { id: true },
      },
    },
  });
  if (file?.aiJobResult) {
    file.visibility = "PRIVATE";
  }
  return file;
}

// The name a new file gets: the one asked for, or "name (n).ext" once that is
// taken, the way the screen has always done. Only names that could collide
// are read, so an account holding many files does not pay for a listing of
// all of them on every upload.
export async function availableStorageFileName({
  userId,
  name,
  prisma,
}: {
  userId: string;
  name: string;
  prisma?: PrismaTransaction;
}): Promise<string> {
  const db = prisma ?? await getDb();
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  const stem = extension ? name.slice(0, -extension.length) : name;
  const rows = await db.file.findMany({
    where: {
      userId,
      aiJobResult: null,
      OR: [
        { name },
        { name: { startsWith: `${stem} (`, endsWith: extension } },
      ],
    },
    select: { name: true },
  });
  const taken = new Set(rows.map((row) => row.name));
  if (!taken.has(name)) return name;
  for (let index = 1; ; index++) {
    const candidate = `${stem} (${index})${extension}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export async function createFile({
  userId,
  name,
  objectKey,
  size,
  mimeType,
  visibility,
  prisma,
  sha256,
}: {
  userId: string;
  name: string;
  objectKey: string;
  size: number;
  mimeType: string;
  visibility: "PUBLIC" | "PRIVATE" | "DEDICATED";
  prisma?: PrismaTransaction;
  sha256?: string;
}) {
  const db = prisma || await getDb();
  return await db.file.create({
    data: {
      objectKey,
      name,
      size,
      // Stored as served, but without stray whitespace, so the listing's
      // kind filter and the screen's classification agree.
      mimeType: mimeType.trim(),
      userId,
      visibility,
      sha256,
    },
  });
}

/** Delete a user file while recording its object key in the cleanup outbox in
 * the same transaction. The outbox is promoted to cleanup only after the row
 * is gone, so a crash cannot lose the key or delete a live file. */
export async function deleteFileWithStorageCleanup({
  fileId,
  userId,
  prisma,
}: {
  fileId: string;
  userId?: string;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    const file = await tx.file.findFirst({
      where: { id: fileId, ...(userId ? { userId } : {}), aiJobResult: null },
    });
    if (!file) throw new Error(`Storage file ${fileId} was not found`);
    const references = await tx.file.findFirst({
      where: { id: fileId, ...(userId ? { userId } : {}) },
      select: fileReferenceSelect,
    });
    if (hasLiveFileReference(references)) {
      throw new Error(`Storage file ${fileId} is still in use`);
    }

    await tx.aiStorageCleanup.create({ data: { objectKey: file.objectKey, aiJobId: null, state: "writing", notBefore: new Date(), leaseToken: null } } as never);
    const deleted = await tx.file.deleteMany({
      where: { id: fileId, ...(userId ? { userId } : {}), aiJobResult: null },
    });
    if (deleted.count !== 1) throw new Error(`Storage file ${fileId} is owned by an AI job`);
    await tx.aiStorageCleanup.updateMany({ where: { objectKey: file.objectKey, state: "writing", leaseToken: null }, data: { state: "cleanup", notBefore: new Date() } } as never);
    return file;
  };
  return prisma ? run(prisma) : startRetryableTransaction(run);
}

/** Delete a dedicated artifact only after its owning pointer/relation was removed.
 * Shared Files remain live, and callers can distinguish retention from deletion. */
export async function deleteUnreferencedFileWithStorageCleanup({
  fileId,
  userId,
  prisma,
}: {
  fileId: string;
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    const file = await tx.file.findFirst({
      where: { id: fileId, userId, aiJobResult: null },
    });
    if (!file) throw new Error(`Storage file ${fileId} was not found`);

    const references = await tx.file.findFirst({
      where: { id: fileId, userId },
      select: fileReferenceSelect,
    });
    if (hasLiveFileReference(references)) {
      return { kind: "retained" as const, record: file };
    }

    const deleted = await deleteFileWithStorageCleanup({ fileId, userId, prisma: tx });
    return { kind: "deleted" as const, record: deleted };
  };
  return prisma ? run(prisma) : startRetryableTransaction(run);
}

/** Batch form of deleteUnreferencedFileWithStorageCleanup. The query count does
 * not grow with the number of files, so a package that owns many release
 * artifacts still finishes inside the interactive transaction timeout. Files
 * still referenced elsewhere are retained, exactly as in the single form. */
export async function deleteUnreferencedFilesWithStorageCleanup({
  fileIds,
  userId,
  prisma,
}: {
  fileIds: string[];
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const uniqueIds = [...new Set(fileIds)];
  const run = async (tx: PrismaTransaction) => {
    if (uniqueIds.length === 0) {
      return { deleted: [] as string[], retained: [] as string[] };
    }
    const files = await tx.file.findMany({
      where: { id: { in: uniqueIds }, userId, aiJobResult: null },
      select: { id: true, objectKey: true, ...fileReferenceSelect },
    });
    // Classify in input order so callers never observe the database's row order.
    const byId = new Map(files.map((file) => [file.id, file]));
    const retained: string[] = [];
    const deletable: { id: string; objectKey: string }[] = [];
    for (const id of uniqueIds) {
      const file = byId.get(id);
      if (!file) throw new Error(`Storage file ${id} was not found`);
      if (hasLiveFileReference(file)) retained.push(id);
      else deletable.push({ id, objectKey: file.objectKey });
    }
    if (deletable.length === 0) {
      return { deleted: [] as string[], retained };
    }

    const now = new Date();
    const objectKeys = deletable.map((file) => file.objectKey);
    await tx.aiStorageCleanup.createMany({
      data: objectKeys.map((objectKey) => ({
        objectKey,
        aiJobId: null,
        leaseToken: null,
        state: "writing",
        notBefore: now,
      })),
    });
    const deleted = await tx.file.deleteMany({
      where: { id: { in: deletable.map((file) => file.id) }, userId, aiJobResult: null },
    });
    if (deleted.count !== deletable.length) {
      throw new Error("Storage files changed before deletion");
    }
    await tx.aiStorageCleanup.updateMany({
      where: { objectKey: { in: objectKeys }, state: "writing", leaseToken: null },
      data: { state: "cleanup", notBefore: now },
    });
    return { deleted: deletable.map((file) => file.id), retained };
  };
  return prisma ? run(prisma) : startRetryableTransaction(run);
}

/** Atomically delete an exact user-selected set, or retain the whole set when
 * any row is dedicated, missing, or still referenced. */
export async function deleteUserFilesWithStorageCleanup({
  fileIds,
  userId,
  prisma,
}: {
  fileIds: string[];
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const uniqueIds = [...new Set(fileIds)];
  const run = async (tx: PrismaTransaction) => {
    if (uniqueIds.length === 0) return { kind: "notFound" as const };
    const files = await tx.file.findMany({
      where: { id: { in: uniqueIds }, userId, aiJobResult: null },
      select: {
        id: true,
        objectKey: true,
        visibility: true,
        ...fileReferenceSelect,
      },
    });
    if (files.length !== uniqueIds.length) {
      return { kind: "notFound" as const };
    }
    if (
      files.some(
        (file) => file.visibility === "DEDICATED" || hasLiveFileReference(file),
      )
    ) {
      return { kind: "inUse" as const };
    }

    // One outbox write and one delete for the whole set, so the statement
    // count does not grow with the selection: the same shape as the
    // unreferenced bulk delete, with the exact-set check above kept.
    const now = new Date();
    const objectKeys = files.map((file) => file.objectKey);
    await tx.aiStorageCleanup.createMany({
      data: objectKeys.map((objectKey) => ({
        objectKey,
        aiJobId: null,
        leaseToken: null,
        state: "writing",
        notBefore: now,
      })),
    });
    const deleted = await tx.file.deleteMany({
      where: { id: { in: uniqueIds }, userId, aiJobResult: null },
    });
    if (deleted.count !== uniqueIds.length) {
      throw new Error("Storage files changed before deletion");
    }
    await tx.aiStorageCleanup.updateMany({
      where: { objectKey: { in: objectKeys }, state: "writing", leaseToken: null },
      data: { state: "cleanup", notBefore: now },
    });
    return { kind: "deleted" as const, records: files };
  };
  return prisma ? run(prisma) : startRetryableTransaction(run);
}

export async function retrieveFilesByIdsAndUserId({
  ids,
  userId,
  prisma,
}: {
  ids: string[];
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.file.findMany({
    where: {
      id: {
        in: ids,
      },
      userId,
      aiJobResult: null,
    },
    select: {
      objectKey: true,
      id: true,
      visibility: true,
    },
  });
}

export async function updateFileVisibility({
  fileId,
  visibility,
  prisma,
}: {
  fileId: string;
  visibility: "PRIVATE" | "PUBLIC";
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const result = await db.file.updateMany({
    where: {
      id: fileId,
      aiJobResult: null,
    },
    data: {
      visibility: visibility,
    },
  });
  if (result.count !== 1) {
    throw new Error(`Storage file ${fileId} is owned by an AI job`);
  }
  return result;
}

// 表示名の変更。専用ファイル (パッケージやプロフィールが握るもの) は他画面が名前を
// 前提にしているため対象外。1 件も更新されなければ false を返し、呼び出し側が
// 「無い」か「触れない」かを判断する。
export async function updateFileName({
  fileId,
  userId,
  name,
  prisma,
}: {
  fileId: string;
  userId: string;
  name: string;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? await getDb();
  const result = await db.file.updateMany({
    where: {
      id: fileId,
      userId,
      aiJobResult: null,
      visibility: { not: "DEDICATED" },
    },
    data: { name },
  });
  return result.count === 1;
}

export async function retrieveStorageFilesByUserId({
  userId,
  prisma,
}: {
  userId?: string;
  prisma?: PrismaTransaction;
}) {
  if (!userId) return [];
  const db = prisma ?? await getDb();
  return await db.file.findMany({
    where: {
      userId,
      aiJobResult: null,
    },
    select: {
      id: true,
      objectKey: true,
      name: true,
      size: true,
      mimeType: true,
      visibility: true,
      createdAt: true,
      folderId: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

const STORAGE_FILE_SELECT = {
  id: true,
  name: true,
  size: true,
  mimeType: true,
  visibility: true,
  createdAt: true,
  folderId: true,
} satisfies Prisma.FileSelect;

// 画面の「種類」フィルタを DB の条件に。判定は core の fileKind と同じ順序で、
// 「その他」は他のどれにも当たらないもの。fileKind は "; charset=..." の
// パラメータを落として比べるので、完全一致の種類はパラメータ付きも受ける。
function storageFileKindWhere(kind: FileKind): Prisma.FileWhereInput {
  const insensitive = "insensitive" as const;
  const exactly = (types: readonly string[]): Prisma.FileWhereInput[] =>
    types.flatMap((type) => [
      { mimeType: { equals: type, mode: insensitive } },
      { mimeType: { startsWith: `${type};`, mode: insensitive } },
    ]);
  const named: Record<Exclude<FileKind, "other">, Prisma.FileWhereInput> = {
    image: { mimeType: { startsWith: "image/", mode: insensitive } },
    video: { mimeType: { startsWith: "video/", mode: insensitive } },
    audio: { mimeType: { startsWith: "audio/", mode: insensitive } },
    archive: { OR: exactly(ARCHIVE_MIME_TYPES) },
    document: {
      OR: [
        { mimeType: { startsWith: "text/", mode: insensitive } },
        ...exactly(DOCUMENT_MIME_TYPES),
      ],
    },
  };
  if (kind === "other") return { NOT: Object.values(named) };
  return named[kind];
}

export type StorageFileListingPage = {
  files: Prisma.FileGetPayload<{ select: typeof STORAGE_FILE_SELECT }>[];
  total: number;
  // 要求より後ろのページが無ければ最後のページに寄せる。
  page: number;
  pageCount: number;
};

// 一覧の 1 ページ。検索中はフォルダーを問わず全体から、そうでなければそのフォルダー
// 直下だけ。並び順には id を添えて、同じ値が並んでもページの境目で行が二重に
// 出たり抜けたりしないようにする。
export async function retrieveStorageFilesPage({
  userId,
  listing,
  pageSize,
  prisma,
}: {
  userId: string;
  listing: StorageListingParams;
  pageSize: number;
  prisma?: PrismaTransaction;
}): Promise<StorageFileListingPage> {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new RangeError("Storage listing page size must be a positive integer");
  }
  const db = prisma ?? await getDb();
  const query = listing.query.trim();
  const where: Prisma.FileWhereInput = {
    userId,
    aiJobResult: null,
    ...(query.length > 0
      ? { name: { contains: query, mode: "insensitive" } }
      : { folderId: listing.folderId }),
    ...(listing.kind ? storageFileKindWhere(listing.kind) : {}),
    ...(listing.visibility ? { visibility: listing.visibility } : {}),
  };
  const total = await db.file.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, listing.page), pageCount);
  const direction = listing.descending ? "desc" : "asc";
  const files = await db.file.findMany({
    where,
    select: STORAGE_FILE_SELECT,
    orderBy: [{ [listing.sort]: direction }, { id: "asc" }],
    skip: (page - 1) * pageSize,
    take: pageSize,
  });
  return { files, total, page, pageCount };
}

// フォルダー削除の確認に出す本数。画面は一覧を 1 ページしか持っていないので、
// 木の下にあるファイルは数えてもらう。
export async function countStorageFilesInFolders({
  userId,
  folderIds,
  prisma,
}: {
  userId: string;
  folderIds: readonly string[];
  prisma?: PrismaTransaction;
}): Promise<number> {
  if (folderIds.length === 0) return 0;
  const db = prisma ?? await getDb();
  return await db.file.count({
    where: { userId, aiJobResult: null, folderId: { in: [...folderIds] } },
  });
}

// 完了済みアップロードの控えから結果を返すための引き当て。名前とサイズまで要る。
export async function findStorageFileByIdAndUserId({
  id,
  userId,
  prisma,
}: {
  id: string;
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.file.findFirst({
    where: { id, userId },
    select: { id: true, name: true, size: true },
  });
}

// 何本持っているか。容量とは別に本数にも上限があるので、その判定に使う。
//
// AI の生成結果は数えない。合計サイズと一覧が除いているのと同じ理由——支払い
// 済みのジョブが作った結果を保存時に断ることはできないので、これを数えると、
// 断れないものが枠を食い、断れる通常のアップロードだけが拒否される。画面に
// 出ていない結果のせいで、空に見えるストレージが上限に達することになる。
export async function countFilesByUserId({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}): Promise<number> {
  const db = prisma ?? (await getDb());
  return await db.file.count({ where: { userId, aiJobResult: null } });
}

export async function sumFileSizeByUserId({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  // 一覧を必要としない使用量表示・アップロード可否判定用。行を引かずに合計
  // サイズだけを 1 クエリで取る。
  //
  // AI の生成結果は除く。支払い済みのジョブが作った結果を保存時に断ることは
  // できないので、これを枠に数えると、断れないものが枠を食い、断れる通常の
  // アップロードだけが拒否される。一覧と名前の重複判定も同じ理由で除いている。
  const result = await db.file.aggregate({
    where: {
      userId,
      aiJobResult: null,
    },
    _sum: {
      size: true,
    },
  });
  return result._sum.size ?? BigInt(0);
}

/** Atomically enforce the file quota/count against committed files and active
 * multipart reservations, then create a dedicated file record. */
export async function createFileWithStorageQuota({
  userId,
  name,
  objectKey,
  size,
  mimeType,
  visibility,
  sha256,
  quotaBytes,
  fileCountLimit,
  prisma,
}: {
  userId: string;
  name: string;
  objectKey: string;
  size: number;
  mimeType: string;
  visibility: "PUBLIC" | "PRIVATE" | "DEDICATED";
  sha256?: string;
  quotaBytes: bigint;
  fileCountLimit: number;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    const [stored, reserved, files, activeUploads] = await Promise.all([
      sumFileSizeByUserId({ userId, prisma: tx }),
      tx.storageUpload.aggregate({
        // Claimed rows still reserve bytes until their multipart cleanup has
        // actually succeeded; excluding them would let failed cleanup escape
        // the same quota enforced by multipart start.
        where: { userId, completedFileId: null },
        _sum: { size: true },
      } as never),
      countFilesByUserId({ userId, prisma: tx }),
      tx.storageUpload.count({ where: { userId, completedFileId: null, abandonedAt: null } } as never),
    ]);
    const total = stored + BigInt(reserved._sum?.size ?? 0) + BigInt(size);
    const count = files + activeUploads;
    if (total > quotaBytes) return { kind: "overQuota" as const };
    if (count >= fileCountLimit) return { kind: "tooManyFiles" as const };
    const created = await createFile({ userId, name, objectKey, size, mimeType, visibility, sha256, prisma: tx });
    const settled = await tx.aiStorageCleanup.deleteMany({
      where: { objectKey, state: "writing", leaseToken: null },
    } as never);
    if (settled.count !== 1) {
      throw new Error(`Storage write outbox ${objectKey} changed before File commit`);
    }
    return { kind: "created" as const, record: created };
  };
  return prisma ? run(prisma) : startRetryableTransaction(run);
}

/** Commit a File and acknowledge its pre-registered storage write outbox in a
 * single transaction. */
export async function createFileAndSettleStorageWrite({
  userId, name, objectKey, size, mimeType, visibility, sha256, prisma,
}: {
  userId: string; name: string; objectKey: string; size: number; mimeType: string;
  visibility: "PUBLIC" | "PRIVATE" | "DEDICATED"; sha256?: string; prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    const created = await createFile({ userId, name, objectKey, size, mimeType, visibility, sha256, prisma: tx });
    const settled = await tx.aiStorageCleanup.deleteMany({
      where: { objectKey, state: "writing", leaseToken: null },
    } as never);
    if (settled.count !== 1) {
      throw new Error(`Storage write outbox ${objectKey} changed before File commit`);
    }
    return created;
  };
  return prisma ? run(prisma) : startRetryableTransaction(run);
}

// 管理画面のストレージ一覧。所有者を引けるようにし、古い順を既定にする
// (プロバイダ切替前のファイルほど古いので、移動の対象を先頭に出す)。
const adminFileSelect = {
  id: true,
  name: true,
  size: true,
  mimeType: true,
  objectKey: true,
  createdAt: true,
  user: { select: { id: true, email: true, name: true } },
} as const;

// ストア間の移動が持つ排他リース。取れるのは誰も持っていないか期限切れのとき
// だけで、持っている間は別の isolate の移動が同じファイルに触れない。
export const FILE_STORAGE_MOVE_LEASE_MILLISECONDS = 30 * 60 * 1000;

export async function acquireFileStorageMoveLease({
  id,
  leaseToken,
  now = new Date(),
  leaseMilliseconds = FILE_STORAGE_MOVE_LEASE_MILLISECONDS,
  prisma,
}: {
  id: string;
  leaseToken: string;
  now?: Date;
  leaseMilliseconds?: number;
  prisma?: PrismaTransaction;
}): Promise<"acquired" | "busy" | "gone"> {
  const db = prisma ?? (await getDb());
  const updated = await db.file.updateMany({
    where: {
      id,
      OR: [
        { storageMoveLeaseUntil: null },
        { storageMoveLeaseUntil: { lte: now } },
      ],
    },
    data: {
      storageMoveLeaseToken: leaseToken,
      storageMoveLeaseUntil: new Date(now.getTime() + leaseMilliseconds),
    },
  });
  if (updated.count === 1) return "acquired";
  const exists = await db.file.findUnique({ where: { id }, select: { id: true } });
  return exists ? "busy" : "gone";
}

// 持っているリースを確かめて延ばす。期限切れや別の持ち主なら false。
// 移動は何かを消す直前に必ずこれを通し、負けていれば何も消さない。
export async function renewFileStorageMoveLease({
  id,
  leaseToken,
  now = new Date(),
  leaseMilliseconds = FILE_STORAGE_MOVE_LEASE_MILLISECONDS,
  prisma,
}: {
  id: string;
  leaseToken: string;
  now?: Date;
  leaseMilliseconds?: number;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? (await getDb());
  const renewed = await db.file.updateMany({
    where: { id, storageMoveLeaseToken: leaseToken, storageMoveLeaseUntil: { gt: now } },
    data: { storageMoveLeaseUntil: new Date(now.getTime() + leaseMilliseconds) },
  });
  return renewed.count === 1;
}

export async function releaseFileStorageMoveLease({
  id,
  leaseToken,
  prisma,
}: {
  id: string;
  leaseToken: string;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? (await getDb());
  const released = await db.file.updateMany({
    where: { id, storageMoveLeaseToken: leaseToken },
    data: { storageMoveLeaseToken: null, storageMoveLeaseUntil: null },
  });
  return released.count === 1;
}

export async function existsFileById({
  id,
  prisma,
}: {
  id: string;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? (await getDb());
  return (await db.file.findUnique({ where: { id }, select: { id: true } })) !== null;
}

export type AdminFileOrder = "asc" | "desc";

export async function listFilesForAdmin({
  query,
  page,
  pageSize,
  order = "asc",
  prisma,
}: {
  query?: string;
  page: number;
  pageSize: number;
  order?: AdminFileOrder;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  const queryMode = "insensitive" as const;
  const where =
    query && query.length > 0
      ? {
          OR: [
            { name: { contains: query, mode: queryMode } },
            { user: { email: { contains: query, mode: queryMode } } },
          ],
        }
      : {};
  const [items, total] = await Promise.all([
    db.file.findMany({
      where,
      select: adminFileSelect,
      // createdAt だけではページ境界で同時刻の行が重複・欠落するため id で確定させる。
      orderBy: [{ createdAt: order }, { id: order }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.file.count({ where }),
  ]);
  return { items, total };
}

// 一括移動の走査。(createdAt, id) の位置から古い順に次の一連を返す。
export async function listFilesForAdminAfter({
  after,
  limit,
  prisma,
}: {
  after?: { createdAt: Date; id: string };
  limit: number;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.file.findMany({
    where: after
      ? {
          OR: [
            { createdAt: { gt: after.createdAt } },
            { createdAt: after.createdAt, id: { gt: after.id } },
          ],
        }
      : {},
    select: adminFileSelect,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit,
  });
}

export async function findFileForAdminById({
  id,
  prisma,
}: {
  id: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.file.findUnique({ where: { id }, select: adminFileSelect });
}
