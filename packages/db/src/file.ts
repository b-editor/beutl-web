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

export async function retrieveFilesByUserId({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  return await db.file.findMany({
    where: {
      userId: userId,
      aiJobResult: null,
    },
  });
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
      mimeType,
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
    if (files.length !== uniqueIds.length) {
      const found = new Set(files.map((file) => file.id));
      const missing = uniqueIds.find((id) => !found.has(id));
      throw new Error(`Storage file ${missing} was not found`);
    }
    const retained = files.filter((file) => hasLiveFileReference(file));
    const deletable = files.filter((file) => !hasLiveFileReference(file));
    if (deletable.length === 0) {
      return { deleted: [] as string[], retained: retained.map((file) => file.id) };
    }

    const objectKeys = deletable.map((file) => file.objectKey);
    await tx.aiStorageCleanup.createMany({
      data: objectKeys.map((objectKey) => ({
        objectKey,
        aiJobId: null,
        leaseToken: null,
        state: "writing",
        notBefore: new Date(),
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
      data: { state: "cleanup", notBefore: new Date() },
    });
    return {
      deleted: deletable.map((file) => file.id),
      retained: retained.map((file) => file.id),
    };
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

    const records = [];
    for (const fileId of uniqueIds) {
      records.push(
        await deleteFileWithStorageCleanup({ fileId, userId, prisma: tx }),
      );
    }
    return { kind: "deleted" as const, records };
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

export async function retrieveFileNamesAndSizesByUserId({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.file.findMany({
    where: {
      userId,
      aiJobResult: null,
    },
    select: {
      size: true,
      name: true,
    },
  });
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
