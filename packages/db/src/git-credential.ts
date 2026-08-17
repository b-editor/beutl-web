import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

export async function listGitCredentialsByUserId({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.gitCredential.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
}

export async function findGitCredential({
  userId,
  id,
  prisma,
}: {
  userId: string;
  id: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.gitCredential.findFirst({
    where: { userId, id },
  });
}

export async function findGitCredentialByName({
  userId,
  name,
  prisma,
}: {
  userId: string;
  name: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.gitCredential.findFirst({
    where: { userId, name },
  });
}

export async function countGitCredentials({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.gitCredential.count({ where: { userId } });
}

export async function createGitCredential({
  userId,
  name,
  forgejoTokenId,
  lastEight,
  prisma,
}: {
  userId: string;
  name: string;
  forgejoTokenId: number;
  lastEight: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.gitCredential.create({
    data: { userId, name, forgejoTokenId, lastEight },
  });
}

export async function deleteGitCredential({
  id,
  prisma,
}: {
  id: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.gitCredential.delete({ where: { id } });
}
