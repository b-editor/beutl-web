import { getDb } from "./provider";
import {
  startRetryableTransaction,
  type PrismaTransaction,
} from "./transaction";
import { storageCleanupReasons } from "./storage-cleanup";

export async function findUserForLibrary({
  id: userId,
  prisma,
}: {
  id: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.user.findUnique({
    where: {
      id: userId,
    },
    select: {
      id: true,
    },
  });
}

export async function existsUserByEmail({
  email,
  prisma,
}: {
  email: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  return !!(await db.user.findFirst({
    where: {
      email: email,
    },
    select: {
      id: true,
    },
  }));
}

export async function existsUserById({
  id,
  prisma,
}: {
  id: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  return !!(await db.user.findFirst({
    where: {
      id: id,
    },
    select: {
      id: true,
    },
  }));
}

export async function updateUserEmail({
  userId,
  email,
  prisma,
}: {
  userId: string;
  email: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  await db.user.update({
    where: {
      id: userId,
    },
    data: {
      email: email,
    }
  });
}

export async function findEmailByUserId({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  return db.user.findFirst({
    where: {
      id: userId,
    },
    select: {
      email: true,
    },
  });
}

export async function getEmailVerifiedByUserId({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  return (
    await db.user.findFirst({
      where: {
        id: userId,
      },
      select: {
        emailVerified: true,
      },
    })
  )?.emailVerified;
}

export async function deleteUserById({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const remove = async (tx: PrismaTransaction) => {
    const files = await tx.file.findMany({
      where: { userId },
      select: { id: true, objectKey: true },
    });
    for (const file of files) {
      await tx.storageCleanup.upsert({
        where: { objectKey: file.objectKey },
        create: {
          id: crypto.randomUUID(),
          fileId: file.id,
          objectKey: file.objectKey,
          reason: storageCleanupReasons.userDeletion,
          availableAt: new Date(),
        },
        update: {
          fileId: file.id,
          reason: storageCleanupReasons.userDeletion,
          availableAt: new Date(),
        },
      });
    }
    await tx.user.delete({ where: { id: userId } });
  };
  return prisma
    ? await remove(prisma)
    : await startRetryableTransaction(remove);
}

export async function listUsers({
  query,
  page,
  pageSize,
}: {
  query?: string;
  page: number;
  pageSize: number;
}) {
  const db = await getDb();
  const queryMode = "insensitive" as const;
  const where =
    query && query.length > 0
      ? {
          OR: [
            {
              email: {
                contains: query,
                mode: queryMode,
              },
            },
            {
              name: {
                contains: query,
                mode: queryMode,
              },
            },
          ],
        }
      : {};
  const [items, total] = await Promise.all([
    db.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        createdAt: true,
        emailVerified: true,
      },
      // createdAt だけではページ境界で同時刻の行が重複・欠落するため id で確定させる。
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.user.count({
      where,
    }),
  ]);
  return { items, total };
}

// 呼び出し側が「打ち切られたか」を判定できるよう、リレーションはこの上限より 1 件多く取得する。
export const USER_DETAIL_RELATION_LIMIT = 50;

export async function getUserDetail({ userId }: { userId: string }) {
  const db = await getDb();
  return db.user.findUnique({
    where: {
      id: userId,
    },
    select: {
      id: true,
      name: true,
      email: true,
      createdAt: true,
      // スキーマ上、User のリレーションフィールド名は大文字始まり
      Package: {
        select: {
          id: true,
          name: true,
          displayName: true,
          published: true,
        },
        orderBy: {
          createdAt: "desc",
        },
        take: USER_DETAIL_RELATION_LIMIT + 1,
      },
      UserPaymentHistory: {
        select: {
          id: true,
          paymentId: true,
          packageId: true,
          createdAt: true,
        },
        orderBy: {
          createdAt: "desc",
        },
        take: USER_DETAIL_RELATION_LIMIT + 1,
      },
      Feedback: {
        select: {
          id: true,
          message: true,
          category: true,
          createdAt: true,
        },
        orderBy: {
          createdAt: "desc",
        },
        take: USER_DETAIL_RELATION_LIMIT + 1,
      },
    },
  });
}

export async function countUsers({
  prisma,
}: {
  prisma?: PrismaTransaction;
} = {}) {
  const db = prisma ?? await getDb();
  return db.user.count();
}
