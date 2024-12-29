import { prisma } from "@/prisma";
import "server-only";

export async function getUserPaymentHistory(userId: string) {
  return await prisma.userPaymentHistory.findMany({
    where: {
      userId: userId,
    },
    orderBy: {
      createdAt: "desc",
    }
  });
}

export async function existsUserPaymentHistory({ userId, packageId }: { userId?: string, packageId: string }) {
  if (!userId) return false;
  return !!await prisma.userPaymentHistory.findFirst({
    where: {
      userId: userId,
      packageId: packageId
    },
    select: {
      id: true
    }
  });
}

export async function createUserPaymentHistory({
  userId, packageId, paymentIntentId
}: {
  userId: string, packageId: string, paymentIntentId: string
}) {
  await prisma.userPaymentHistory.create({
    data: {
      userId: userId,
      packageId: packageId,
      paymentId: paymentIntentId,
    }
  })
}