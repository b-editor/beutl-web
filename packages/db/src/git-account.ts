import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

export async function findGitAccountByUserId({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.gitAccount.findUnique({
    where: { userId },
  });
}

export async function findGitAccountByForgejoUsername({
  forgejoUsername,
  prisma,
}: {
  forgejoUsername: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.gitAccount.findUnique({
    where: { forgejoUsername },
  });
}

export async function createGitAccount({
  userId,
  forgejoUserId,
  forgejoUsername,
  prisma,
}: {
  userId: string;
  forgejoUserId: number;
  forgejoUsername: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.gitAccount.create({
    data: { userId, forgejoUserId, forgejoUsername },
  });
}

// Forgejo 側のユーザー名が既に使われていないかを確かめる。
// Forgejo が最終的な一意性を保証するが、採番の段階で衝突を減らしておく。
export async function existsGitAccountUsername({
  forgejoUsername,
  prisma,
}: {
  forgejoUsername: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  const found = await db.gitAccount.findUnique({
    where: { forgejoUsername },
    select: { userId: true },
  });
  return found !== null;
}
