import { getDb } from "./provider";
import {
  startRetryableTransaction,
  type PrismaTransaction,
} from "./transaction";
import { scheduleStripeCheckoutCleanup } from "./stripe-checkout-cleanup";

export async function getOrCreateProCheckoutAttempt({
  userId,
  billingOfferId,
  now,
  expiresAt,
  customerId,
  paramsJson,
  prisma,
}: {
  userId: string;
  billingOfferId: string;
  now: Date;
  expiresAt: Date;
  customerId: string;
  paramsJson?: string;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    const deletionIntent = await tx.accountDeletionIntent.findFirst({
      where: { userId, expiresAt: { gt: now } },
      select: { userId: true },
    });
    if (deletionIntent) {
      throw new Error("Account deletion is already authorized");
    }

    const existing = await tx.proCheckoutAttempt.findUnique({
      where: { userId },
    });
    if (existing?.accountDeletionAt) {
      throw new Error("Account deletion is already authorized");
    }
    // A local expiry is only a lease for an unbound creation key. Once Stripe
    // has assigned a Checkout Session, that Session remains payable until its
    // actual Stripe state has been resolved by the caller.
    if (
      existing &&
      (existing.stripeCheckoutSessionId !== null ||
        (existing.expiresAt.getTime() > now.getTime() &&
          existing.billingOfferId === billingOfferId))
    ) {
      return existing;
    }

    return await tx.proCheckoutAttempt.upsert({
      where: { userId },
      create: {
        userId,
        billingOfferId,
        checkoutKey: crypto.randomUUID(),
        customerId,
        paramsJson: paramsJson ?? null,
        expiresAt,
      },
      update: {
        checkoutKey: crypto.randomUUID(),
        billingOfferId,
        stripeCheckoutSessionId: null,
        ...(customerId ? { customerId } : {}),
        ...(paramsJson ? { paramsJson } : {}),
        expiresAt,
      },
    });
  };

  if (prisma) {
    return await run(prisma);
  }
  return await startRetryableTransaction(run);
}

export async function findProCheckoutAttemptBySessionId({
  userId,
  stripeCheckoutSessionId,
  prisma,
}: {
  userId: string;
  stripeCheckoutSessionId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.proCheckoutAttempt.findFirst({
    where: { userId, stripeCheckoutSessionId },
  });
}

export async function bindProCheckoutSession({
  userId,
  checkoutKey,
  stripeCheckoutSessionId,
  expiresAt,
  now = new Date(),
  prisma,
}: {
  userId: string;
  checkoutKey: string;
  stripeCheckoutSessionId: string;
  expiresAt: Date;
  now?: Date;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    const current = await tx.proCheckoutAttempt.findUnique({
      where: { userId },
    });
    const deletionIntent = await tx.accountDeletionIntent.findFirst({
      where: { userId, expiresAt: { gt: now } },
      select: { userId: true },
    });
    if (deletionIntent || current?.accountDeletionAt) {
      // Preserve the just-created remote handle even though the attempt is no
      // longer redirectable. Account-deletion finalization and the checkout
      // action can then race safely to resolve the exact same Stripe Session.
      if (
        current?.checkoutKey === checkoutKey &&
        (current.stripeCheckoutSessionId === null ||
          current.stripeCheckoutSessionId === stripeCheckoutSessionId)
      ) {
        await tx.proCheckoutAttempt.updateMany({
          where: {
            userId,
            checkoutKey,
            ...(current.stripeCheckoutSessionId === null
              ? { stripeCheckoutSessionId: null }
              : {}),
          },
          data: {
            stripeCheckoutSessionId,
            expiresAt: now,
          },
        });
        const customerId = current.customerId ?? (await tx.customer.findUnique({
          where: { userId },
          select: { stripeId: true },
        }))?.stripeId;
        if (customerId) {
          await scheduleStripeCheckoutCleanup({
            sessionId: stripeCheckoutSessionId,
            userId,
            kind: "pro",
            customerId,
            billingOfferId: current?.billingOfferId,
            prisma: tx,
          });
        }
      }
      return "account-deletion-authorized" as const;
    }
    if (!current || current.checkoutKey !== checkoutKey) {
      return "superseded" as const;
    }
    if (current.stripeCheckoutSessionId === stripeCheckoutSessionId) {
      return "already-bound" as const;
    }
    if (current.stripeCheckoutSessionId !== null) {
      return "superseded" as const;
    }
    const updated = await tx.proCheckoutAttempt.updateMany({
      where: {
        userId,
        checkoutKey,
        stripeCheckoutSessionId: null,
      },
      data: {
        stripeCheckoutSessionId,
        expiresAt,
      },
    });
    return updated.count === 1 ? "bound" as const : "superseded" as const;
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

export async function setProCheckoutAttemptParams({ userId, checkoutKey, paramsJson, prisma }: { userId: string; checkoutKey: string; paramsJson: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.proCheckoutAttempt.updateMany({ where: { userId, checkoutKey, stripeCheckoutSessionId: null, accountDeletionAt: null }, data: { paramsJson } });
}

export async function claimDetachedProCheckoutAttempts({ now, leaseToken, leaseExpiresAt, limit = 50, prisma }: { now: Date; leaseToken: string; leaseExpiresAt: Date; limit?: number; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  const rows = await db.proCheckoutAttempt.findMany({ where: { accountDeletionAt: { not: null }, stripeCheckoutSessionId: null, recoveryInterventionAt: null, recoveryCompletedAt: null, OR: [{ recoveryLeaseExpiresAt: null }, { recoveryLeaseExpiresAt: { lte: now } }], AND: [{ OR: [{ recoveryNotBefore: null }, { recoveryNotBefore: { lte: now } }] }] }, take: limit });
  const claimed = [];
  for (const row of rows) {
    const updated = await db.proCheckoutAttempt.updateMany({ where: { userId: row.userId, stripeCheckoutSessionId: null, recoveryLeaseToken: row.recoveryLeaseToken, OR: [{ recoveryLeaseExpiresAt: null }, { recoveryLeaseExpiresAt: { lte: now } }] }, data: { recoveryLeaseToken: leaseToken, recoveryLeaseExpiresAt: leaseExpiresAt, recoveryAttempts: { increment: 1 } } });
    if (updated.count === 1) claimed.push({ ...row, recoveryLeaseToken: leaseToken });
  }
  return claimed;
}

export async function completeDetachedProCheckoutRecovery({ userId, leaseToken, stripeCheckoutSessionId, now = new Date(), prisma }: { userId: string; leaseToken: string; stripeCheckoutSessionId: string; now?: Date; prisma?: PrismaTransaction }) {
  const run = async (tx: PrismaTransaction) => {
    const row = await tx.proCheckoutAttempt.findUnique({ where: { userId } });
    if (!row || row.recoveryLeaseToken !== leaseToken || row.stripeCheckoutSessionId !== null || !row.customerId) return false;
    const updated = await tx.proCheckoutAttempt.updateMany({ where: { userId, recoveryLeaseToken: leaseToken, stripeCheckoutSessionId: null }, data: { stripeCheckoutSessionId, recoveryLeaseToken: null, recoveryLeaseExpiresAt: null } });
    if (updated.count !== 1) return false;
    await scheduleStripeCheckoutCleanup({ sessionId: stripeCheckoutSessionId, userId, kind: "pro", customerId: row.customerId, billingOfferId: row.billingOfferId, now, prisma: tx });
    return true;
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

export async function rescheduleDetachedProCheckoutRecovery({ userId, leaseToken, notBefore, lastError, prisma }: { userId: string; leaseToken: string; notBefore: Date; lastError: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.proCheckoutAttempt.updateMany({ where: { userId, recoveryLeaseToken: leaseToken }, data: { recoveryLeaseToken: null, recoveryLeaseExpiresAt: null, recoveryNotBefore: notBefore, recoveryLastError: lastError } });
}

export async function markDetachedProCheckoutRecoveryIntervention({ userId, leaseToken, lastError, prisma }: { userId: string; leaseToken: string; lastError: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.proCheckoutAttempt.updateMany({ where: { userId, recoveryLeaseToken: leaseToken }, data: { recoveryLeaseToken: null, recoveryLeaseExpiresAt: null, recoveryInterventionAt: new Date(), recoveryLastError: lastError } });
}

export async function markDetachedProCheckoutRecoveryTerminal({ userId, leaseToken, prisma }: { userId: string; leaseToken: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.proCheckoutAttempt.updateMany({ where: { userId, recoveryLeaseToken: leaseToken, stripeCheckoutSessionId: null }, data: { recoveryLeaseToken: null, recoveryLeaseExpiresAt: null, recoveryNotBefore: null, recoveryCompletedAt: new Date() } });
}

export async function deleteBoundProCheckoutAttempt({
  userId,
  checkoutKey,
  stripeCheckoutSessionId,
  prisma,
}: {
  userId: string;
  checkoutKey: string;
  stripeCheckoutSessionId: string;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? await getDb();
  const deleted = await db.proCheckoutAttempt.deleteMany({
    where: { userId, checkoutKey, stripeCheckoutSessionId },
  });
  return deleted.count === 1;
}

export async function expireProCheckoutAttempt({
  userId,
  checkoutKey,
  now,
  prisma,
}: {
  userId: string;
  checkoutKey: string;
  now: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  await db.proCheckoutAttempt.updateMany({
    where: {
      userId,
      checkoutKey,
    },
    data: {
      expiresAt: now,
    },
  });
}

export async function deleteProCheckoutAttempt({
  userId,
  stripeCheckoutSessionId,
  prisma,
}: {
  userId: string;
  stripeCheckoutSessionId: string;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? await getDb();
  const deleted = await db.proCheckoutAttempt.deleteMany({
    where: { userId, stripeCheckoutSessionId },
  });
  return deleted.count === 1;
}

export async function deleteProCheckoutAttemptBySessionId({ stripeCheckoutSessionId, prisma }: { stripeCheckoutSessionId: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.proCheckoutAttempt.deleteMany({ where: { stripeCheckoutSessionId } });
}
