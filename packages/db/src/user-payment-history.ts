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

// A payment that still pays for its package.
const activePayment = { fulfillmentValidated: true, revokedAt: null } as const;

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
      ...activePayment,
    },
    select: {
      id: true,
    },
  }));
}

/** The packages among packageIds that the user has paid for. */
export async function findPaidPackageIds({
  userId,
  packageIds,
  prisma,
}: {
  userId: string;
  packageIds: string[];
  prisma?: PrismaTransaction;
}) {
  if (packageIds.length === 0) return [];
  const db = prisma || await getDb();
  const payments = await db.userPaymentHistory.findMany({
    where: {
      userId: userId,
      packageId: { in: packageIds },
      ...activePayment,
    },
    select: {
      packageId: true,
    },
  });
  return payments.map((payment) => payment.packageId);
}

