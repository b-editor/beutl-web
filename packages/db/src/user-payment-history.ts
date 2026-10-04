import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

export async function getUserPaymentHistory({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  return await db.userPaymentHistory.findMany({
    where: {
      userId: userId,
    },
    orderBy: {
      createdAt: "desc",
    },
  });
}

export async function existsUserPaymentHistory({
  userId,
  packageId,
  prisma,
}: {
  userId?: string;
  packageId: string;
  prisma?: PrismaTransaction;
}) {
  if (!userId) return false;
  const db = prisma || await getDb();
  return !!(await db.userPaymentHistory.findFirst({
    where: {
      userId: userId,
      packageId: packageId,
      fulfillmentValidated: true,
      revokedAt: null,
    },
    select: {
      id: true,
    },
  }));
}

