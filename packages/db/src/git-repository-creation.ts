import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

/**
 * これから作るリポジトリの予約。
 *
 * **Forgejo を触る前に書く。** 名前の重複を Forgejo 上の不在確認だけで判断すると、
 * 同じ名前の作成が同時に来たときに両方が通ってしまう。
 */
export class GitRepositoryNameTakenError extends Error {
  constructor(
    readonly ownerUsername: string,
    readonly name: string,
  ) {
    super(`${ownerUsername}/${name} is already being created`);
    this.name = "GitRepositoryNameTakenError";
  }
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
  prisma,
}: {
  ownerUsername: string;
  name: string;
  /** 管理者の名前空間で使う名前。201 の前に決めて控える。 */
  holdingName: string;
  prisma?: PrismaTransaction;
}): Promise<string> {
  const db = prisma ?? (await getDb());
  try {
    const row = await db.gitRepositoryCreation.create({
      data: { ownerUsername, name, holdingName },
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

/**
 * 放置された予約。作成の途中で処理が消えたもの。
 * @param olderThan これより前に作られたものだけ (進行中のものを掴まないため)。
 */
export async function listStaleGitRepositoryCreations({
  olderThan,
  limit = 20,
  prisma,
}: {
  olderThan: Date;
  limit?: number;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.gitRepositoryCreation.findMany({
    where: { createdAt: { lt: olderThan } },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
}

/** 放置された予約の件数。 */
export async function countStaleGitRepositoryCreations({
  olderThan,
  prisma,
}: {
  olderThan: Date;
  prisma?: PrismaTransaction;
}): Promise<number> {
  const db = prisma ?? (await getDb());
  return await db.gitRepositoryCreation.count({
    where: { createdAt: { lt: olderThan } },
  });
}
