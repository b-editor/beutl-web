import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

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

export async function deleteFile({
  fileId,
  prisma,
}: {
  fileId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  const file = await db.file.findFirst({
    where: {
      id: fileId,
      aiJobResult: null,
    },
  });
  if (!file) {
    throw new Error(`Storage file ${fileId} was not found`);
  }
  const deleted = await db.file.deleteMany({
    where: {
      id: fileId,
      aiJobResult: null,
    },
  });
  if (deleted.count !== 1) {
    throw new Error(`Storage file ${fileId} is owned by an AI job`);
  }
  return file;
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
    },
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
