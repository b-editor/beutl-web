import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

/**
 * 復元で生き返るものの墓標。
 *
 * 退会 (GitAccountDeletion) と違い、こちらは**こちら側に何も残らない操作**の控え。
 * トークンを 1 本失効させると GitCredential の行ごと消え、リポジトリを消せば
 * Forgejo にも DB にも何も残らない。Forgejo をその前の時点へ戻すと、失効した
 * はずのトークン (端末には平文が残っている) と、消したはずのリポジトリが復活する。
 * 控えが無ければ、それを消し直したかどうかを誰も数えられない。
 */

/** 失効させたトークンを控える。**Forgejo を触る前に書く。** */
export async function recordGitCredentialRevocation({
  userId,
  forgejoUsername,
  forgejoTokenId,
  lastEight,
  prisma,
}: {
  userId: string;
  forgejoUsername: string;
  forgejoTokenId: number;
  lastEight: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  await db.gitCredentialRevocation.create({
    data: { userId, forgejoUsername, forgejoTokenId, lastEight },
  });
}

/** 消したリポジトリを控える。**Forgejo を触る前に書く。** */
export async function recordGitRepositoryDeletion({
  forgejoRepoId,
  ownerUsername,
  name,
  prisma,
}: {
  forgejoRepoId: number;
  ownerUsername: string;
  name: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  // 同じ id を消し直すことがある (前の消去が曖昧に終わった場合)。上書きでよい。
  await db.gitRepositoryDeletion.upsert({
    where: { forgejoRepoId },
    create: { forgejoRepoId, ownerUsername, name },
    // 世代の確認はやり直す。名前も新しい方を採る。
    update: {
      ownerUsername,
      name,
      deletedAt: new Date(),
      checkedGeneration: null,
    },
  });
}

/**
 * この世代でまだ確認していない失効の控え。
 *
 * 世代を渡さない場合は「一度も確認していないもの」。復元が一度も無い間は、
 * ここを回す必要が無い (生き返る機会が無いので)。
 */
export async function listGitCredentialRevocations({
  generation,
  limit = 20,
  prisma,
}: {
  generation: string | null;
  limit?: number;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.gitCredentialRevocation.findMany({
    where: notCheckedIn(generation),
    orderBy: [{ revokedAt: "asc" }, { id: "asc" }],
    take: limit,
  });
}

export async function listGitRepositoryDeletions({
  generation,
  limit = 20,
  prisma,
}: {
  generation: string | null;
  limit?: number;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.gitRepositoryDeletion.findMany({
    where: { needsReview: false, ...notCheckedIn(generation) },
    orderBy: [{ deletedAt: "asc" }, { forgejoRepoId: "asc" }],
    take: limit,
  });
}

/**
 * 「この世代で確認していない」の条件。
 *
 * 時計では数えない。復元ごとに世代を 1 つ登録し、確認した控えにその世代を書く。
 * 時刻で比べると、Worker と DB の時計のずれや、復元前に行った確認を取り違える。
 */
function notCheckedIn(generation: string | null) {
  return generation === null
    ? { checkedGeneration: null }
    : {
        OR: [
          { checkedGeneration: null },
          { checkedGeneration: { not: generation } },
        ],
      };
}

/** 確認できた。この世代の分は終わり。 */
export async function markGitCredentialRevocationChecked({
  id,
  generation,
  prisma,
}: {
  id: string;
  generation: string | null;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  await db.gitCredentialRevocation.updateMany({
    where: { id },
    data: {
      checkedGeneration: generation,
      lastAttemptAt: new Date(),
      lastError: null,
    },
  });
}

export async function markGitRepositoryDeletionChecked({
  forgejoRepoId,
  generation,
  prisma,
}: {
  forgejoRepoId: number;
  generation: string | null;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  await db.gitRepositoryDeletion.updateMany({
    where: { forgejoRepoId },
    data: {
      checkedGeneration: generation,
      lastAttemptAt: new Date(),
      lastError: null,
    },
  });
}

/** 確認できなかった。**世代は書かない** (書くと終わったことになる)。 */
export async function recordGitCredentialRevocationAttempt({
  id,
  error,
  prisma,
}: {
  id: string;
  error: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  await db.gitCredentialRevocation.updateMany({
    where: { id },
    data: {
      attempts: { increment: 1 },
      lastAttemptAt: new Date(),
      lastError: error.slice(0, 500),
    },
  });
}

export async function recordGitRepositoryDeletionAttempt({
  forgejoRepoId,
  error,
  prisma,
}: {
  forgejoRepoId: number;
  error: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  await db.gitRepositoryDeletion.updateMany({
    where: { forgejoRepoId },
    data: {
      attempts: { increment: 1 },
      lastAttemptAt: new Date(),
      lastError: error.slice(0, 500),
    },
  });
}

/** その id が別のリポジトリを指している。自動では決められないので人に回す。 */
export async function markGitRepositoryDeletionNeedsReview({
  forgejoRepoId,
  reason,
  prisma,
}: {
  forgejoRepoId: number;
  reason: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  await db.gitRepositoryDeletion.updateMany({
    where: { forgejoRepoId },
    data: {
      needsReview: true,
      lastAttemptAt: new Date(),
      lastError: reason.slice(0, 500),
    },
  });
}

/**
 * 見張る必要が無くなった控えを消す。
 *
 * 生き返らせられるのは、**まだ手元にあるバックアップで戻せる範囲だけ**。それより
 * 古い控えを持ち続けても、消し直す相手が現れることはない。渡す幅はバックアップの
 * 保持期間より長くすること。
 */
export async function pruneGitResurrectionTombstones({
  before,
  prisma,
}: {
  before: Date;
  prisma?: PrismaTransaction;
}): Promise<{ credentials: number; repositories: number }> {
  const db = prisma ?? (await getDb());
  const credentials = await db.gitCredentialRevocation.deleteMany({
    where: { revokedAt: { lt: before } },
  });
  const repositories = await db.gitRepositoryDeletion.deleteMany({
    // 人の確認待ちは残す。消すと、何を見ればよかったのか分からなくなる。
    where: { needsReview: false, deletedAt: { lt: before } },
  });
  return {
    credentials: credentials.count,
    repositories: repositories.count,
  };
}
