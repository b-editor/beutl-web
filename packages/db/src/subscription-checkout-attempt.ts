// サブスクリプションのチェックアウト試行。ユーザー × プランで 1 行。AI Pro も
// ストレージも同じ手続きで、cleanup の kind にはプラン ID が入る。
import { getDb } from "./provider";
import {
  startRetryableTransaction,
  type PrismaTransaction,
} from "./transaction";
import { scheduleStripeCheckoutCleanup } from "./stripe-checkout-cleanup";

export async function getOrCreateSubscriptionCheckoutAttempt({
  userId,
  planId,
  tier = null,
  billingOfferId,
  now,
  expiresAt,
  customerId,
  paramsJson,
  prisma,
}: {
  userId: string;
  planId: string;
  tier?: string | null;
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

    const existing = await tx.subscriptionCheckoutAttempt.findUnique({
      where: { userId_planId: { userId, planId } },
    });
    const settledDeletionTombstone = existing?.accountDeletionAt !== null &&
      existing?.accountDeletionAt !== undefined &&
      existing.recoveryCompletedAt !== null &&
      existing.stripeCheckoutSessionId === null;
    if (existing?.accountDeletionAt && !settledDeletionTombstone) {
      throw new Error("Account deletion is already authorized");
    }
    // A local expiry is only a lease for an unbound creation key. Once Stripe
    // has assigned a Checkout Session, that Session remains payable until its
    // actual Stripe state has been resolved by the caller.
    if (
      existing &&
      !settledDeletionTombstone &&
      (existing.stripeCheckoutSessionId !== null ||
        (existing.expiresAt.getTime() > now.getTime() &&
          existing.billingOfferId === billingOfferId))
    ) {
      return existing;
    }

    return await tx.subscriptionCheckoutAttempt.upsert({
      where: { userId_planId: { userId, planId } },
      create: {
        userId,
        planId,
        tier,
        billingOfferId,
        checkoutKey: crypto.randomUUID(),
        customerId,
        paramsJson: paramsJson ?? null,
        expiresAt,
      },
      update: {
        checkoutKey: crypto.randomUUID(),
        tier,
        billingOfferId,
        stripeCheckoutSessionId: null,
        ...(customerId ? { customerId } : {}),
        ...(paramsJson ? { paramsJson } : {}),
        expiresAt,
        accountDeletionAt: null,
        recoveryLeaseToken: null,
        recoveryLeaseExpiresAt: null,
        recoveryAttempts: 0,
        recoveryLastError: null,
        recoveryInterventionAt: null,
        recoveryNotBefore: null,
        recoveryCompletedAt: null,
      },
    });
  };

  if (prisma) {
    return await run(prisma);
  }
  return await startRetryableTransaction(run);
}

export async function findSubscriptionCheckoutAttemptBySessionId({
  userId,
  stripeCheckoutSessionId,
  prisma,
}: {
  userId: string;
  stripeCheckoutSessionId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.subscriptionCheckoutAttempt.findFirst({
    where: { userId, stripeCheckoutSessionId },
  });
}

export async function bindSubscriptionCheckoutSession({
  userId,
  planId,
  checkoutKey,
  stripeCheckoutSessionId,
  expiresAt,
  now = new Date(),
  prisma,
}: {
  userId: string;
  planId: string;
  checkoutKey: string;
  stripeCheckoutSessionId: string;
  expiresAt: Date;
  now?: Date;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    const current = await tx.subscriptionCheckoutAttempt.findUnique({
      where: { userId_planId: { userId, planId } },
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
        await tx.subscriptionCheckoutAttempt.updateMany({
          where: {
            userId,
            planId,
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
            kind: planId,
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
    const updated = await tx.subscriptionCheckoutAttempt.updateMany({
      where: {
        userId,
        planId,
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

export async function setSubscriptionCheckoutAttemptParams({ userId, checkoutKey, paramsJson, prisma }: { userId: string; checkoutKey: string; paramsJson: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.subscriptionCheckoutAttempt.updateMany({ where: { userId, checkoutKey, stripeCheckoutSessionId: null, accountDeletionAt: null }, data: { paramsJson } });
}

// Attempts frozen by account deletion before a Session was bound. Every plan's
// rows come back; each carries its planId and tier so the caller can replay
// the create with the right key.
export async function claimDetachedSubscriptionCheckoutAttempts({ now, leaseToken, leaseExpiresAt, limit = 50, prisma }: { now: Date; leaseToken: string; leaseExpiresAt: Date; limit?: number; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  const rows = await db.subscriptionCheckoutAttempt.findMany({ where: { accountDeletionAt: { not: null }, stripeCheckoutSessionId: null, recoveryInterventionAt: null, recoveryCompletedAt: null, OR: [{ recoveryLeaseExpiresAt: null }, { recoveryLeaseExpiresAt: { lte: now } }], AND: [{ OR: [{ recoveryNotBefore: null }, { recoveryNotBefore: { lte: now } }] }] }, take: limit });
  const claimed = [];
  for (const row of rows) {
    const updated = await db.subscriptionCheckoutAttempt.updateMany({ where: { userId: row.userId, planId: row.planId, stripeCheckoutSessionId: null, recoveryLeaseToken: row.recoveryLeaseToken, OR: [{ recoveryLeaseExpiresAt: null }, { recoveryLeaseExpiresAt: { lte: now } }] }, data: { recoveryLeaseToken: leaseToken, recoveryLeaseExpiresAt: leaseExpiresAt, recoveryAttempts: { increment: 1 } } });
    if (updated.count === 1) claimed.push({ ...row, recoveryLeaseToken: leaseToken });
  }
  return claimed;
}

export async function completeDetachedSubscriptionCheckoutRecovery({ userId, planId, leaseToken, stripeCheckoutSessionId, now = new Date(), prisma }: { userId: string; planId: string; leaseToken: string; stripeCheckoutSessionId: string; now?: Date; prisma?: PrismaTransaction }) {
  const run = async (tx: PrismaTransaction) => {
    const row = await tx.subscriptionCheckoutAttempt.findUnique({ where: { userId_planId: { userId, planId } } });
    if (!row || row.recoveryLeaseToken !== leaseToken || row.stripeCheckoutSessionId !== null || !row.customerId) return false;
    const updated = await tx.subscriptionCheckoutAttempt.updateMany({ where: { userId, planId, recoveryLeaseToken: leaseToken, stripeCheckoutSessionId: null }, data: { stripeCheckoutSessionId, recoveryLeaseToken: null, recoveryLeaseExpiresAt: null } });
    if (updated.count !== 1) return false;
    await scheduleStripeCheckoutCleanup({ sessionId: stripeCheckoutSessionId, userId, kind: planId, customerId: row.customerId, billingOfferId: row.billingOfferId, now, prisma: tx });
    return true;
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

export async function rescheduleDetachedSubscriptionCheckoutRecovery({ userId, planId, leaseToken, notBefore, lastError, prisma }: { userId: string; planId: string; leaseToken: string; notBefore: Date; lastError: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.subscriptionCheckoutAttempt.updateMany({ where: { userId, planId, recoveryLeaseToken: leaseToken }, data: { recoveryLeaseToken: null, recoveryLeaseExpiresAt: null, recoveryNotBefore: notBefore, recoveryLastError: lastError } });
}

export async function markDetachedSubscriptionCheckoutRecoveryIntervention({ userId, planId, leaseToken, lastError, prisma }: { userId: string; planId: string; leaseToken: string; lastError: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.subscriptionCheckoutAttempt.updateMany({ where: { userId, planId, recoveryLeaseToken: leaseToken }, data: { recoveryLeaseToken: null, recoveryLeaseExpiresAt: null, recoveryInterventionAt: new Date(), recoveryLastError: lastError } });
}

export async function markDetachedSubscriptionCheckoutRecoveryTerminal({ userId, planId, leaseToken, prisma }: { userId: string; planId: string; leaseToken: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.subscriptionCheckoutAttempt.updateMany({ where: { userId, planId, recoveryLeaseToken: leaseToken, stripeCheckoutSessionId: null }, data: { recoveryLeaseToken: null, recoveryLeaseExpiresAt: null, recoveryNotBefore: null, recoveryCompletedAt: new Date() } });
}

export async function deleteBoundSubscriptionCheckoutAttempt({
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
  const deleted = await db.subscriptionCheckoutAttempt.deleteMany({
    where: { userId, checkoutKey, stripeCheckoutSessionId },
  });
  return deleted.count === 1;
}

export async function expireSubscriptionCheckoutAttempt({
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
  await db.subscriptionCheckoutAttempt.updateMany({
    where: {
      userId,
      checkoutKey,
    },
    data: {
      expiresAt: now,
    },
  });
}

export async function deleteSubscriptionCheckoutAttempt({
  userId,
  stripeCheckoutSessionId,
  prisma,
}: {
  userId: string;
  stripeCheckoutSessionId: string;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? await getDb();
  const deleted = await db.subscriptionCheckoutAttempt.deleteMany({
    where: { userId, stripeCheckoutSessionId },
  });
  return deleted.count === 1;
}

export async function deleteSubscriptionCheckoutAttemptBySessionId({ stripeCheckoutSessionId, prisma }: { stripeCheckoutSessionId: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.subscriptionCheckoutAttempt.deleteMany({ where: { stripeCheckoutSessionId } });
}
