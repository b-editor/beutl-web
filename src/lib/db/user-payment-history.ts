import "server-only";
import { prisma as sharedPrisma } from "@/prisma";
import type { PrismaTransaction } from "./transaction";

export async function getUserPaymentHistory({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  return await (prisma || await sharedPrisma()).userPaymentHistory.findMany({
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
  return !!(await (prisma || await sharedPrisma()).userPaymentHistory.findFirst({
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
  await (prisma || await sharedPrisma()).userPaymentHistory.create({
    data: {
      userId: userId,
      packageId: packageId,
      paymentId: paymentIntentId,
    },
  });
}
