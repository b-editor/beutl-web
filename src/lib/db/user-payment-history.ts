import "server-only";
import { getDbAsync } from "@/prisma";
import type { PrismaTransaction } from "./transaction";

export async function getUserPaymentHistory({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDbAsync();
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
  const db = prisma || await getDbAsync();
  return !!(await db.userPaymentHistory.findFirst({
    where: {
      userId: userId,
      packageId: packageId,
    },
    select: {
      id: true,
    },
  }));
}

export async function createUserPaymentHistory({
  userId,
  packageId,
  paymentIntentId,
  prisma,
}: {
  userId: string;
  packageId: string;
  paymentIntentId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDbAsync();
  await db.userPaymentHistory.create({
    data: {
      userId: userId,
      packageId: packageId,
      paymentId: paymentIntentId,
    },
  });
}
