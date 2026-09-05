import { getDb } from "./provider";
import { startRetryableTransaction, type PrismaTransaction } from "./transaction";

const ACTIVE_STATUSES = ["required", "retry"] as const;

export async function schedulePackagePaymentRefundAttempt({
  paymentIntentId,
  amount,
  currency,
  reason,
  customerId,
  userId,
  packageId,
  now = new Date(),
  prisma,
}: {
  paymentIntentId: string;
  amount: number;
  currency: string;
  reason: string;
  customerId?: string | null;
  userId?: string | null;
  packageId?: string | null;
  now?: Date;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    const existing = await tx.packagePaymentRefundAttempt.findUnique({ where: { paymentIntentId } });
    if (existing) {
      if (existing.amount !== amount || existing.currency !== currency.toLowerCase() || existing.customerId !== (customerId ?? null) || existing.userId !== (userId ?? null) || existing.packageId !== (packageId ?? null)) throw new Error(`Package refund ${paymentIntentId} identity conflict`);
      if (existing.status === "refunded" || existing.status === "intervention") return existing;
      return await tx.packagePaymentRefundAttempt.update({ where: { id: existing.id }, data: { notBefore: existing.notBefore < now ? existing.notBefore : now } });
    }
    return await tx.packagePaymentRefundAttempt.create({
      data: {
        paymentIntentId,
        amount,
        customerId: customerId ?? null,
        userId: userId ?? null,
        packageId: packageId ?? null,
        currency: currency.toLowerCase(),
        reason,
        status: "required",
        notBefore: now,
      },
    });
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

export async function listDuePackagePaymentRefundAttempts({
  now,
  limit = 50,
  prisma,
}: { now: Date; limit?: number; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.packagePaymentRefundAttempt.findMany({
    where: {
      status: { in: [...ACTIVE_STATUSES] },
      notBefore: { lte: now },
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
    },
    orderBy: [{ notBefore: "asc" }, { createdAt: "asc" }],
    take: limit,
  });
}

export async function claimPackagePaymentRefundAttempt({
  id,
  now,
  leaseToken,
  leaseExpiresAt,
  prisma,
}: {
  id: string;
  now: Date;
  leaseToken: string;
  leaseExpiresAt: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const updated = await db.packagePaymentRefundAttempt.updateMany({
    where: {
      id,
      status: { in: [...ACTIVE_STATUSES] },
      notBefore: { lte: now },
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
    },
    data: {
      status: "retry",
      leaseToken,
      leaseExpiresAt,
      attempts: { increment: 1 },
    },
  });
  if (updated.count !== 1) return null;
  return await db.packagePaymentRefundAttempt.findUnique({ where: { id } });
}

export async function completePackagePaymentRefundAttempt({
  id,
  leaseToken,
  prisma,
}: { id: string; leaseToken: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.packagePaymentRefundAttempt.updateMany({
    where: { id, status: "retry", leaseToken },
    data: { status: "refunded", leaseToken: null, leaseExpiresAt: null },
  });
}

export async function reschedulePackagePaymentRefundAttempt({
  id,
  leaseToken,
  notBefore,
  lastError,
  prisma,
}: {
  id: string;
  leaseToken: string;
  notBefore: Date;
  lastError: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.packagePaymentRefundAttempt.updateMany({
    where: { id, status: "retry", leaseToken },
    data: { status: "required", notBefore, lastError, leaseToken: null, leaseExpiresAt: null },
  });
}

export async function markPackagePaymentRefundIntervention({
  id,
  leaseToken,
  lastError,
  prisma,
}: {
  id: string;
  leaseToken: string;
  lastError: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.packagePaymentRefundAttempt.updateMany({
    where: { id, status: "retry", leaseToken },
    data: {
      status: "intervention",
      lastError,
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
}

/** Lists refund attempts paused for operator intervention. */
export async function listPackagePaymentRefundInterventions({
  page = 1,
  pageSize = 50,
  prisma,
}: { page?: number; pageSize?: number; prisma?: PrismaTransaction } = {}) {
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new RangeError("Package refund intervention page must be a positive integer");
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new RangeError("Package refund intervention page size must be between 1 and 100");
  }
  const db = prisma ?? await getDb();
  const where = { status: "intervention" };
  const [items, total] = await Promise.all([
    db.packagePaymentRefundAttempt.findMany({
      where,
      orderBy: [{ updatedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.packagePaymentRefundAttempt.count({ where }),
  ]);
  return { items, total };
}

/**
 * Reopens one paused refund using an exact updatedAt compare-and-swap.
 * The caller must immediately run the canonical Stripe reconciler after this
 * transition; no payment/refund identity is accepted from the operator.
 */
export async function resumePackagePaymentRefundIntervention({
  id,
  expectedUpdatedAt,
  now = new Date(),
  prisma,
}: {
  id: string;
  expectedUpdatedAt: Date;
  now?: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const updated = await db.packagePaymentRefundAttempt.updateMany({
    where: { id, status: "intervention", updatedAt: expectedUpdatedAt },
    data: {
      status: "required",
      notBefore: now,
      attempts: 0,
      lastError: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: now,
    },
  });
  if (updated.count !== 1) return { status: "conflict" as const };
  return { status: "resumed" as const, updatedAt: now };
}
