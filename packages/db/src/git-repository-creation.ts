import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

/**
 * これから作る / 名前を変えるリポジトリの予約。
 *
 * **Forgejo を触る前に書く。** 名前の重複を Forgejo 上の不在確認だけで判断すると、
 * 同じ名前の操作が同時に来たときに両方が通ってしまう。作成も改名も同じここを通す。
 */
export class GitRepositoryNameTakenError extends Error {
  constructor(
    readonly ownerUsername: string,
    readonly repositoryName: string,
  ) {
    super(`${ownerUsername}/${repositoryName} is already being created`);
    this.name = "GitRepositoryNameTakenError";
  }
}

/**
 * 予約の一意キー。
 *
 * Forgejo は `UNIQUE(owner_id, lower_name)` で名前を押さえている (実測)。
 * 大文字小文字を区別すると `Proj` と `proj` が両方予約でき、Forgejo 側では
 * 衝突するので片方が預かり名のまま残る。
 */
export function normalizeRepositoryName(name: string): string {
  return name.toLowerCase();
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

export async function reserveGitRepositoryName({
  ownerUsername,
  name,
  holdingName,
  intentId,
  leaseUntil,
  prisma,
}: {
  ownerUsername: string;
  name: string;
  /** 管理者の名前空間で使う名前。作成のときだけ。改名では名前そのものを使う。 */
  holdingName: string;
  intentId: string;
  leaseUntil: Date;
  prisma?: PrismaTransaction;
}): Promise<string> {
  const db = prisma ?? (await getDb());
  try {
    const row = await db.gitRepositoryCreation.create({
      data: {
        ownerUsername,
        name,
        normalizedName: normalizeRepositoryName(name),
        holdingName,
        intentId,
        leaseUntil,
      },
    });
    return row.id;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new GitRepositoryNameTakenError(ownerUsername, name);
    }
    throw error;
  }
}

/** 応答で分かったリポジトリ id を紐付ける。 */
export async function attachGitRepositoryCreationId({
  id,
  forgejoRepoId,
  prisma,
}: {
  id: string;
  forgejoRepoId: number;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  await db.gitRepositoryCreation.updateMany({
    where: { id },
    data: { forgejoRepoId },
  });
}

/**
 * 予約を外す。
 *
 * **外してよいのは、決着が付いたときだけ。** 相手が存在しないと確かめられた、
 * 畳めた、あるいは渡し切れた場合。曖昧なまま外すと、追えない預かりものが残る
 * うえに同じ名前を再び予約でき、2 つの預かりものが同じ相手に渡される。
 */
export async function releaseGitRepositoryReservation({
  id,
  prisma,
}: {
  id: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  await db.gitRepositoryCreation.deleteMany({ where: { id } });
}

/** 渡し先と名前で外す。片付けが終わった側から呼ぶ。 */
export async function releaseGitRepositoryReservationFor({
  ownerUsername,
  name,
  prisma,
}: {
  ownerUsername: string;
  name: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  await db.gitRepositoryCreation.deleteMany({
    where: { ownerUsername, normalizedName: normalizeRepositoryName(name) },
  });
}

/**
 * 期限が切れた予約。作成の途中で処理が消えたもの。
 *
 * 時間ではなく**期限**で判断する。作成が遅いだけの処理を横から回収しないため。
 */
export async function listExpiredGitRepositoryCreations({
  now = new Date(),
  limit = 20,
  prisma,
}: {
  now?: Date;
  limit?: number;
  prisma?: PrismaTransaction;
} = {}) {
  const db = prisma ?? (await getDb());
  return await db.gitRepositoryCreation.findMany({
    where: { OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
}

/** 取り掛かる。印を差し替えて期限を押さえる。 */
export async function claimGitRepositoryCreation({
  id,
  intentId,
  leaseUntil,
  now = new Date(),
  prisma,
}: {
  id: string;
  intentId: string;
  leaseUntil: Date;
  now?: Date;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? (await getDb());
  const { count } = await db.gitRepositoryCreation.updateMany({
    where: {
      id,
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    data: { intentId, leaseUntil },
  });
  return count === 1;
}

/** 期限を延ばす。**自分の印であるときだけ**通る。 */
export async function renewGitRepositoryCreationLease({
  id,
  intentId,
  leaseUntil,
  prisma,
}: {
  id: string;
  intentId: string;
  leaseUntil: Date;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? (await getDb());
  const { count } = await db.gitRepositoryCreation.updateMany({
    where: { id, intentId },
    data: { leaseUntil },
  });
  return count === 1;
}

/** 片付いていない予約の件数。 */
export async function countGitRepositoryCreations({
  prisma,
}: { prisma?: PrismaTransaction } = {}): Promise<number> {
  const db = prisma ?? (await getDb());
  return await db.gitRepositoryCreation.count();
}
