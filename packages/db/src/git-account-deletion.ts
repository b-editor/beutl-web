import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

/**
 * 退会処理の途中経過。Forgejo 側を消し切るまで残る。
 *
 * 「残っている = まだ片付いていない」という 1 つの意味しか持たせない。再試行の
 * 対象を選ぶのも、資格情報の発行を拒むのも、この行の有無だけで決める。
 */

export async function createGitAccountDeletion({
  userId,
  forgejoUsername,
  forgejoUserId,
  prisma,
}: {
  userId: string;
  forgejoUsername: string;
  forgejoUserId: number;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  // やり直しでも同じ行を使う。attempts は recordGitAccountDeletionAttempt で数える。
  return await db.gitAccountDeletion.upsert({
    where: { userId },
    create: { userId, forgejoUsername, forgejoUserId },
    update: { forgejoUsername, forgejoUserId },
  });
}

export async function findGitAccountDeletion({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.gitAccountDeletion.findUnique({ where: { userId } });
}

export async function deleteGitAccountDeletion({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  await db.gitAccountDeletion.deleteMany({ where: { userId } });
}

/** 古いものから順に。何度も失敗しているものが先頭に居座らないよう試行回数も見る。 */
export async function listPendingGitAccountDeletions({
  limit = 20,
  prisma,
}: {
  limit?: number;
  prisma?: PrismaTransaction;
} = {}) {
  const db = prisma ?? (await getDb());
  return await db.gitAccountDeletion.findMany({
    orderBy: [{ attempts: "asc" }, { createdAt: "asc" }],
    take: limit,
  });
}

export async function recordGitAccountDeletionAttempt({
  userId,
  error,
  prisma,
}: {
  userId: string;
  error: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  await db.gitAccountDeletion.updateMany({
    where: { userId },
    data: {
      attempts: { increment: 1 },
      lastAttemptAt: new Date(),
      // 例外の文字列は長くなりうる。原因が分かる範囲で切る。
      lastError: error.slice(0, 500),
    },
  });
}
