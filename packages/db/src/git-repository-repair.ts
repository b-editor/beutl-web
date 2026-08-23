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
  intendedOwner,
  intendedName,
  reservationId,
  intentId,
  leaseUntil,
  reason,
  prisma,
}: {
  forgejoRepoId: number;
  ownerUsername: string;
  name: string;
  /** 管理者の手元で組み立て中なら、渡す先と最終的な名前。 */
  intendedOwner?: string;
  intendedName?: string;
  /** どの予約から生まれたか。渡し切ったときにその世代だけを外すため。 */
  reservationId?: string;
  /** 新しく積む場合に握る印と期限。**既にある行には効かない** (claim が決める)。 */
  intentId?: string;
  leaseUntil?: Date;
  reason: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  const handover = {
    ...(intendedOwner === undefined ? {} : { intendedOwner }),
    ...(intendedName === undefined ? {} : { intendedName }),
    ...(reservationId === undefined ? {} : { reservationId }),
  };
  await db.gitRepositoryRepair.upsert({
    where: { forgejoRepoId },
    create: {
      forgejoRepoId,
      ownerUsername,
      name,
      ...handover,
      ...(intentId === undefined ? {} : { intentId }),
      ...(leaseUntil === undefined ? {} : { leaseUntil }),
      lastError: reason.slice(0, 500),
    },
    // 既に積んであるなら試行回数は保つ。名前は変わりうるので新しい方を採る。
    // **intentId と leaseUntil は触らない。** 誰が握っているかは claim が決める。
    // ここで書き換えると、掴んでいる相手を横から追い出せる。
    update: {
      ownerUsername,
      name,
      ...handover,
      lastError: reason.slice(0, 500),
    },
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
  now = new Date(),
  prisma,
}: {
  notAttemptedSince: Date;
  limit?: number;
  now?: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.gitRepositoryRepair.findMany({
    // 2 つの OR を並べると後の方で上書きされる。AND で束ねる。
    where: {
      // 人の確認待ちは自動では触らない。
      needsReview: false,
      AND: [
        { OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
        {
          OR: [
            { lastAttemptAt: null },
            { lastAttemptAt: { lt: notAttemptedSince } },
          ],
        },
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
/**
 * 取り掛かる。**intentId を新しいものに差し替える。**
 *
 * 期限だけを進めても、前の持ち主は自分の intentId を握ったままなので、期限切れの
 * 後に息を吹き返せば譲渡も控えの削除も続けられる。差し替えれば、前の持ち主の
 * 以後の更新は 1 件も通らない。
 *
 * @returns 掴めたかどうか。
 */
export async function claimGitRepositoryRepair({
  forgejoRepoId,
  intentId,
  notAttemptedSince,
  leaseUntil,
  now = new Date(),
  prisma,
}: {
  forgejoRepoId: number;
  /** この実行が握る新しい印。以後の更新はすべてこれで条件付ける。 */
  intentId: string;
  notAttemptedSince: Date;
  leaseUntil: Date;
  now?: Date;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? (await getDb());
  const { count } = await db.gitRepositoryRepair.updateMany({
    where: {
      forgejoRepoId,
      needsReview: false,
      AND: [
        { OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
        {
          OR: [
            { lastAttemptAt: null },
            { lastAttemptAt: { lt: notAttemptedSince } },
          ],
        },
      ],
    },
    data: { intentId, leaseUntil, lastAttemptAt: now },
  });
  return count === 1;
}

/** 期限を延ばす。**自分の印であるときだけ**通る。 */
export async function renewGitRepositoryRepairLease({
  forgejoRepoId,
  intentId,
  leaseUntil,
  prisma,
}: {
  forgejoRepoId: number;
  intentId: string;
  leaseUntil: Date;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? (await getDb());
  const { count } = await db.gitRepositoryRepair.updateMany({
    where: { forgejoRepoId, intentId },
    data: { leaseUntil },
  });
  return count === 1;
}

/** 自動では決着できないものとして外す。人が確認するまで触らない。 */
export async function markGitRepositoryRepairNeedsReview({
  forgejoRepoId,
  intentId,
  reason,
  prisma,
}: {
  forgejoRepoId: number;
  intentId: string;
  reason: string;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? (await getDb());
  const { count } = await db.gitRepositoryRepair.updateMany({
    where: { forgejoRepoId, intentId },
    data: {
      needsReview: true,
      leaseUntil: null,
      lastError: reason.slice(0, 500),
    },
  });
  return count === 1;
}

/** 人の確認待ちの件数。0 でなければ誰かが見に行く必要がある。 */
export async function countGitRepositoryRepairsNeedingReview({
  prisma,
}: { prisma?: PrismaTransaction } = {}): Promise<number> {
  const db = prisma ?? (await getDb());
  return await db.gitRepositoryRepair.count({ where: { needsReview: true } });
}

export async function recordGitRepositoryRepairAttempt({
  forgejoRepoId,
  intentId,
  error,
  prisma,
}: {
  forgejoRepoId: number;
  /** 握っている印。引き取られた後の処理が記録を上書きしないようにする。 */
  intentId: string;
  error: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  await db.gitRepositoryRepair.updateMany({
    where: { forgejoRepoId, intentId },
    data: {
      attempts: { increment: 1 },
      lastAttemptAt: new Date(),
      lastError: error.slice(0, 500),
    },
  });
}

/**
 * 片付いたので控えを外す。
 *
 * `intentId` を渡すと自分が握っている行だけを消す。引き取られた後の処理が、
 * 引き取った側の記録を消さないようにするため。
 */
export async function deleteGitRepositoryRepair({
  forgejoRepoId,
  intentId,
  prisma,
}: {
  forgejoRepoId: number;
  intentId?: string;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? (await getDb());
  const { count } = await db.gitRepositoryRepair.deleteMany({
    where: {
      forgejoRepoId,
      ...(intentId === undefined ? {} : { intentId }),
    },
  });
  return count === 1;
}

/**
 * 自動で片付く見込みのある件数。人の確認待ちは別に数えるので含めない。
 * 0 でなければ、LFS の効かないリポジトリか、渡し切れていない預かりものが残っている。
 */
export async function countGitRepositoryRepairs({
  prisma,
}: { prisma?: PrismaTransaction } = {}): Promise<number> {
  const db = prisma ?? (await getDb());
  return await db.gitRepositoryRepair.count({ where: { needsReview: false } });
}
