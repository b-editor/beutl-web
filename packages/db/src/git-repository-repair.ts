import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

/**
 * テンプレートを入れ切れなかったリポジトリの控え。
 *
 * その場で直せず、読み取り専用にすることもできなかった場合に積む。記録が無いと、
 * .gitattributes の無いリポジトリが push を受けられる状態のまま誰にも気付かれない。
 *
 * 相手は **Forgejo のリポジトリ id**。名前は改名で変わり、空いた名前を別の
 * リポジトリが取ることがあるので、名前で引き直すと別物を止めてしまう。
 */
export async function enqueueGitRepositoryRepair({
  forgejoRepoId,
  ownerUsername,
  name,
  reason,
  prisma,
}: {
  forgejoRepoId: number;
  ownerUsername: string;
  name: string;
  reason: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  await db.gitRepositoryRepair.upsert({
    where: { forgejoRepoId },
    create: {
      forgejoRepoId,
      ownerUsername,
      name,
      lastError: reason.slice(0, 500),
    },
    // 既に積んであるなら試行回数は保つ。名前は変わりうるので新しい方を採る。
    update: { ownerUsername, name, lastError: reason.slice(0, 500) },
  });
}

/**
 * 片付いていないものを古い順に返す。
 *
 * @param notAttemptedSince これより後に試したものは飛ばす。
 */
export async function listGitRepositoryRepairs({
  notAttemptedSince,
  limit = 20,
  prisma,
}: {
  notAttemptedSince: Date;
  limit?: number;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.gitRepositoryRepair.findMany({
    where: {
      OR: [
        { lastAttemptAt: null },
        { lastAttemptAt: { lt: notAttemptedSince } },
      ],
    },
    orderBy: [{ attempts: "asc" }, { createdAt: "asc" }],
    take: limit,
  });
}

/**
 * 取り掛かる印を付ける。
 * @returns 掴めたかどうか。重なった定期実行が同じ相手を触らないようにする。
 */
export async function claimGitRepositoryRepair({
  forgejoRepoId,
  notAttemptedSince,
  prisma,
}: {
  forgejoRepoId: number;
  notAttemptedSince: Date;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? (await getDb());
  const { count } = await db.gitRepositoryRepair.updateMany({
    where: {
      forgejoRepoId,
      OR: [
        { lastAttemptAt: null },
        { lastAttemptAt: { lt: notAttemptedSince } },
      ],
    },
    data: { lastAttemptAt: new Date() },
  });
  return count === 1;
}

export async function recordGitRepositoryRepairAttempt({
  forgejoRepoId,
  error,
  prisma,
}: {
  forgejoRepoId: number;
  error: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  await db.gitRepositoryRepair.updateMany({
    where: { forgejoRepoId },
    data: {
      attempts: { increment: 1 },
      lastAttemptAt: new Date(),
      lastError: error.slice(0, 500),
    },
  });
}

/** 片付いたので控えを外す。 */
export async function deleteGitRepositoryRepair({
  forgejoRepoId,
  prisma,
}: {
  forgejoRepoId: number;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  await db.gitRepositoryRepair.deleteMany({ where: { forgejoRepoId } });
}

/** 片付いていない件数。0 でなければ、LFS の効かないリポジトリが残っている。 */
export async function countGitRepositoryRepairs({
  prisma,
}: { prisma?: PrismaTransaction } = {}): Promise<number> {
  const db = prisma ?? (await getDb());
  return await db.gitRepositoryRepair.count();
}
