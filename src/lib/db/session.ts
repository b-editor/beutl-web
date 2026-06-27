import "server-only";
import { getDbAsync } from "@/prisma";
import type { PrismaTransaction } from "./transaction";

export async function createSession({
  token,
  expiresAt,
  userId,
  prisma,
}: {
  token: string;
  expiresAt: Date;
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDbAsync();
  return await db.session.create({
    data: {
      token,
      expiresAt,
      userId,
    },
  });
}

export async function deleteSessionsByToken({
  token,
  prisma,
}: {
  token: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDbAsync();
  return await db.session.deleteMany({
    where: {
      token,
    },
  });
}
