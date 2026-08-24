import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

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
  const db = prisma || await getDb();
  await db.user.delete({
    where: {
      id: userId,
    }
  });
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

// 集計結果は userId しか持たないため、表示名を引くための最小限の読み取り。
export async function listUserLabels({
  userIds,
  prisma,
}: {
  userIds: string[];
  prisma?: PrismaTransaction;
}) {
  if (userIds.length === 0) {
    return [];
  }
  const db = prisma ?? await getDb();
  return db.user.findMany({
    where: {
      id: {
        in: userIds,
      },
    },
    select: {
      id: true,
      name: true,
      email: true,
    },
  });
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

// 一度に書く件数。CockroachDB の 1 文あたりの上限と、トランザクションの
// 期限のあいだで選んだ数。
const CLEANUP_BATCH_SIZE = 500;

export async function enqueueUserStorageCleanups({
  userId,
  now = new Date(),
  prisma,
}: {
  userId: string;
  now?: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  const files = await db.file.findMany({
    where: { userId },
    select: { objectKey: true },
  });
  // 途中のアップロードも。完了の控えを書く前に落ちたものは、R2 には出来上がった
  // オブジェクトがあるのに File が無い——行ごと消してしまうと、そのオブジェクト
  // を指す手掛かりはどこにも残らない。墓標には抱えているものが無いので飛ばす。
  const uploads = await db.storageUpload.findMany({
    where: { userId, NOT: { objectKey: "" } },
    select: { objectKey: true },
  });
  const objectKeys = new Set([
    ...files.map((file) => file.objectKey),
    ...uploads.map((upload) => upload.objectKey),
  ]);
  // まとめて書く。1 件ずつだと、上限いっぱいまでファイルを持つ利用者の削除は
  // 1 万回の往復になり、その全部がカスケードと同じトランザクションの中に入る
  // ——期限に間に合わなければ、削除そのものが最後まで通らない。
  const keys = [...objectKeys];
  for (let at = 0; at < keys.length; at += CLEANUP_BATCH_SIZE) {
    const batch = keys.slice(at, at + CLEANUP_BATCH_SIZE);
    await db.aiStorageCleanup.createMany({
      data: batch.map((objectKey) => ({
        objectKey,
        aiJobId: null,
        state: "cleanup",
        notBefore: now,
      })),
      skipDuplicates: true,
    });
    // 既にあった行を、いま置きたい状態へ揃える。createMany は飛ばすだけなので。
    await db.aiStorageCleanup.updateMany({
      where: { objectKey: { in: batch } },
      data: {
        aiJobId: null,
        state: "cleanup",
        notBefore: now,
      },
    });
  }
  return objectKeys.size;
}
