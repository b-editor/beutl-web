import { GitAccountDeletionPhase } from "@prisma/client";
import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

/**
 * 退会処理の途中経過。Forgejo 側を消し切るまで残る。
 *
 * phase の意味は 1 つずつしかない。
 *   BLOCKING       退会を始めた。資格情報の発行を止める。**まだ purge しない**
 *   READY_TO_PURGE Beutl 側のユーザーが実際に消えた。purge してよい
 *
 * BLOCKING のまま purge すると、ローカルの削除が失敗して生き残った利用者の
 * Forgejo アカウントとリポジトリを消すことになる。
 */

export { GitAccountDeletionPhase };

/**
 * 退会の意思表示。対象がまだ分からない段階でも書ける。
 *
 * @returns この行を持っている intentId。同じ利用者の退会が同時に走ったとき、
 *   先に立てた方の id が返る。取り消してよいのは自分の id のときだけ。
 */
export async function startGitAccountDeletion({
  userId,
  intentId,
  prisma,
}: {
  userId: string;
  intentId: string;
  prisma?: PrismaTransaction;
}): Promise<string> {
  const db = prisma ?? (await getDb());
  const row = await db.gitAccountDeletion.upsert({
    where: { userId },
    create: { userId, intentId },
    // やり直しでも phase は戻さない。READY_TO_PURGE を BLOCKING に落とすと、
    // 既に消えた利用者の後始末が二度と進まなくなる。intentId も先勝ちのまま。
    update: {},
  });
  return row.intentId;
}

/** Forgejo 側の対象が分かったら記録する。 */
export async function setGitAccountDeletionTarget({
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
  await db.gitAccountDeletion.updateMany({
    where: { userId },
    data: { forgejoUsername, forgejoUserId },
  });
}

/**
 * purge してよい状態にする。
 *
 * **ユーザー削除と同じトランザクションで呼ぶこと。** 別々にすると、ユーザーが
 * 残っているのに purge 可能な行だけができる瞬間があり、そこで再試行が走ると
 * 生きている利用者の Git データを消す。
 */
export async function markGitAccountDeletionReady({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  const { count } = await db.gitAccountDeletion.updateMany({
    where: { userId },
    data: { phase: GitAccountDeletionPhase.READY_TO_PURGE },
  });

  // 印が消えていたらユーザーを消してはいけない。誰も後始末できなくなり、
  // その間に発行されたトークンが Forgejo に残ったままになる。
  // 呼び出し元は同じトランザクションなので、投げれば削除ごと巻き戻る。
  if (count !== 1) {
    throw new Error(
      `expected exactly one GitAccountDeletion for ${userId}, updated ${count}`,
    );
  }
}

/**
 * 自動では決着できない状態にする。
 * 控えの相手が見つからない、あるいは別人になっている場合。人が確認するまで放置する。
 */
export async function markGitAccountDeletionNeedsReview({
  userId,
  reason,
  prisma,
}: {
  userId: string;
  reason: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  await db.gitAccountDeletion.updateMany({
    where: { userId },
    data: {
      phase: GitAccountDeletionPhase.NEEDS_REVIEW,
      lastAttemptAt: new Date(),
      lastError: reason.slice(0, 500),
    },
  });
}

/**
 * まだ BLOCKING の印を取り消す。
 *
 * 退会の準備段階で失敗すると利用者は残るので、印だけ残ると資格情報を二度と
 * 発行できなくなる。READY_TO_PURGE 以降は消さない (Beutl 側は既に消えている)。
 */
export async function cancelPendingGitAccountDeletion({
  userId,
  intentId,
  prisma,
}: {
  userId: string;
  intentId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  await db.gitAccountDeletion.deleteMany({
    // **自分が立てた印だけ**。同じ利用者の退会が 2 本走ると 1 つの行を共有するので、
    // 片方の失敗で消すと、進行中のもう片方が印を失ったまま利用者を削除してしまう。
    where: { userId, intentId, phase: GitAccountDeletionPhase.BLOCKING },
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

/**
 * 片付け待ちを古い順に返す。**READY_TO_PURGE だけ**。
 * BLOCKING はまだ利用者が生きている可能性があるので、決して混ぜない。
 */
export async function listPendingGitAccountDeletions({
  limit = 20,
  /** これより後に試したものは飛ばす。重なった定期実行が同じ行を掴まないため。 */
  skipAttemptedSince,
  prisma,
}: {
  limit?: number;
  skipAttemptedSince?: Date;
  prisma?: PrismaTransaction;
} = {}) {
  const db = prisma ?? (await getDb());
  return await db.gitAccountDeletion.findMany({
    where: {
      phase: GitAccountDeletionPhase.READY_TO_PURGE,
      ...(skipAttemptedSince
        ? {
            OR: [
              { lastAttemptAt: null },
              { lastAttemptAt: { lt: skipAttemptedSince } },
            ],
          }
        : {}),
    },
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
