import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";
import { StorageCleanupBusyError } from "./ai-job";
import { enqueueStorageMultipartCleanups } from "./storage-multipart-cleanup";
import { freezeStorageUploadForAccountDeletion } from "./storage-upload";

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
  // Freeze every unfinished upload in the same serializable transaction that
  // writes detached outboxes and deletes the User. A creator holding a null-id
  // snapshot then loses its attach CAS; once it observes the remote handle it
  // writes that handle to the same user-independent multipart outbox.
  const uploads = await db.storageUpload.findMany({
    where: { userId, NOT: { objectKey: "" } },
    select: {
      id: true,
      userId: true,
      objectKey: true,
      uploadId: true,
      name: true,
      mimeType: true,
      size: true,
      partSize: true,
      completedFileId: true,
      abandonedAt: true,
      createdAt: true,
      startState: true,
      creationLeaseUntil: true,
      creationLeaseToken: true,
      cleanupLeaseUntil: true,
      cleanupLeaseToken: true,
    },
  });
  const frozenUploads: typeof uploads = [];
  for (const upload of uploads) {
    if (upload.completedFileId !== null) continue;
    if (upload.abandonedAt === null) {
      const claimed = await freezeStorageUploadForAccountDeletion({
        id: upload.id,
        userId,
        now,
        expected: {
          createdAt: upload.createdAt,
          objectKey: upload.objectKey,
          uploadId: upload.uploadId,
          name: upload.name,
          mimeType: upload.mimeType,
          size: upload.size,
          partSize: upload.partSize,
          abandonedAt: upload.abandonedAt,
          startState: upload.startState,
          creationLeaseUntil: upload.creationLeaseUntil,
          creationLeaseToken: upload.creationLeaseToken,
          cleanupLeaseUntil: upload.cleanupLeaseUntil,
          cleanupLeaseToken: upload.cleanupLeaseToken,
        },
        prisma: db,
      });
      if (!claimed) {
        throw new StorageCleanupBusyError([upload.objectKey]);
      }
    }
    frozenUploads.push(upload);
  }

  await enqueueStorageMultipartCleanups({
    handles: frozenUploads.flatMap((upload) =>
      upload.uploadId && upload.uploadId.length > 0
        ? [{ objectKey: upload.objectKey, uploadId: upload.uploadId }]
        : []),
    notBefore: now,
    prisma: db,
  });

  // Object deletion is intentionally independent from multipart abort. A File
  // owns an object, and an unfinished upload may have joined its object before
  // its completion receipt committed. Neither case puts uploadId in this row.
  const keys = [
    ...new Set([
      ...files.map((file) => file.objectKey),
      ...uploads.map((upload) => upload.objectKey),
    ]),
  ];
  // まとめて書く。1 件ずつだと、上限いっぱいまでファイルを持つ利用者の削除は
  // 1 万回の往復になり、その全部がカスケードと同じトランザクションの中に入る
  // ——期限に間に合わなければ、削除そのものが最後まで通らない。
  for (let at = 0; at < keys.length; at += CLEANUP_BATCH_SIZE) {
    const batch = keys.slice(at, at + CLEANUP_BATCH_SIZE);
    const existing = await db.aiStorageCleanup.findMany({
      where: { objectKey: { in: batch } },
      select: {
        objectKey: true,
        leaseToken: true,
        state: true,
        notBefore: true,
      },
    });
    // A lease token means a cleaner owns the remote side effect until it
    // explicitly settles. Expiry only makes the row claimable through the
    // cleanup CAS; normal account-deletion writers must never overwrite it.
    const busy = existing.filter((row) => row.leaseToken !== null);
    if (busy.length > 0) {
      throw new StorageCleanupBusyError(busy.map((row) => row.objectKey));
    }
    await db.aiStorageCleanup.createMany({
      data: batch.map((objectKey) => ({
        objectKey,
        aiJobId: null,
        leaseToken: null,
        state: "cleanup",
        notBefore: now,
      })),
      skipDuplicates: true,
    });
    // Existing rows are updated once per batch. Active leases were rejected
    // above, so this cannot move a claimed row backwards.
    if (existing.length > 0) {
      await db.aiStorageCleanup.updateMany({
        where: {
          objectKey: { in: existing.map((row) => row.objectKey) },
          OR: [{ leaseToken: null }, { notBefore: { lte: now } }],
        },
        data: { aiJobId: null, state: "cleanup", notBefore: now },
      });
    }
  }
  return keys.length;
}
