import { addPurchasedCredits, type StripePaymentDetails } from "./credit-account";
import { getDb } from "./provider";
import {
  startRetryableTransaction,
  type PrismaTransaction,
} from "./transaction";
import { scheduleTopUpDuplicateRefundAttempt } from "./topup-duplicate-refund-attempt";

export const TOP_UP_REFUND_PROCESSING_STATUSES = [
  "refund_required",
  "refund_pending",
  "refund_failed",
] as const;

const CHECKOUT_SLOT_TERMINAL_STATUSES = new Set([
  "fulfilled",
  "refunded",
  "refund_not_required",
  "expired",
]);

const NON_REOPENABLE_REFUND_STATUSES = new Set([
  "fulfilled",
  "refunded",
]);

function isRefundProcessingStatus(status: string): boolean {
  return TOP_UP_REFUND_PROCESSING_STATUSES.some((item) => item === status);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "P2002";
}

async function expectedDuplicateRefundsAreSettled(
  tx: PrismaTransaction,
  encodedPaymentIntentIds: string,
): Promise<boolean> {
  const ids = JSON.parse(encodedPaymentIntentIds || "[]") as string[];
  if (ids.length === 0) return true;
  const rows = await tx.topUpDuplicateRefundAttempt.findMany({
    where: { stripePaymentIntentId: { in: ids } },
    select: {
      stripePaymentIntentId: true,
      status: true,
      amount: true,
      refundedAmount: true,
    },
  });
  return ids.every((id) => rows.some((row) =>
    row.stripePaymentIntentId === id &&
    row.status === "refunded" &&
    row.refundedAmount === row.amount));
}

export async function getOrCreateTopUpCheckoutAttempt({
  proposedAttemptId,
  ownerUserId,
  stripeCustomerId,
  billingOfferId,
  checkoutKey,
  paramsJson,
  expiresAt,
  now = new Date(),
  prisma,
}: {
  proposedAttemptId: string;
  ownerUserId: string;
  stripeCustomerId: string;
  billingOfferId: string;
  checkoutKey: string;
  paramsJson: string;
  expiresAt: Date;
  now?: Date;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    const deletionIntent = await tx.accountDeletionIntent.findFirst({
      where: { userId: ownerUserId, expiresAt: { gt: now } },
      select: { userId: true },
    });
    if (deletionIntent) {
      throw new Error("Account deletion is already authorized");
    }

    const active = await tx.topUpCheckoutAttempt.findUnique({
      where: { activeOwnerKey: ownerUserId },
    });
    if (active) {
      if (active.recoveryInterventionAt !== null) {
        throw new Error("Top-up checkout requires operator recovery");
      }
      if (CHECKOUT_SLOT_TERMINAL_STATUSES.has(active.status)) {
        const released = await tx.topUpCheckoutAttempt.updateMany({
          where: {
            id: active.id,
            activeOwnerKey: ownerUserId,
            status: active.status,
            updatedAt: active.updatedAt,
          },
          data: { activeOwnerKey: null },
        });
        if (released.count !== 1) {
          throw new Error("Top-up active slot changed while releasing a terminal attempt");
        }
      } else {
        if (active.accountDeletionAt !== null) {
          throw new Error("Top-up checkout is being compensated for account deletion");
        }
        const competing = await tx.topUpCheckoutAttempt.findMany({
          where: {
            ownerUserId,
            status: { notIn: [...CHECKOUT_SLOT_TERMINAL_STATUSES] },
          },
          orderBy: [{ createdAt: "asc" }],
          take: 2,
        });
        if (competing.some((attempt) => attempt.id !== active.id)) {
          throw new Error(
            "Multiple unresolved legacy top-up attempts require reconciliation",
          );
        }
        return active;
      }
    }

    const unresolved = await tx.topUpCheckoutAttempt.findMany({
      where: {
        ownerUserId,
        activeOwnerKey: null,
        status: { notIn: [...CHECKOUT_SLOT_TERMINAL_STATUSES] },
      },
      orderBy: [{ createdAt: "asc" }],
      take: 2,
    });
    if (unresolved.length > 1) {
      throw new Error(
        "Multiple unresolved legacy top-up attempts require reconciliation",
      );
    }
    if (unresolved.length === 1) {
      const legacy = unresolved[0]!;
      if (legacy.recoveryInterventionAt !== null) {
        throw new Error("Top-up checkout requires operator recovery");
      }
      if (legacy.accountDeletionAt !== null) {
        throw new Error("Top-up checkout is being compensated for account deletion");
      }
      const claimed = await tx.topUpCheckoutAttempt.updateMany({
        where: {
          id: legacy.id,
          activeOwnerKey: null,
          status: legacy.status,
          updatedAt: legacy.updatedAt,
        },
        data: { activeOwnerKey: ownerUserId },
      });
      if (claimed.count !== 1) {
        throw new Error("Top-up legacy active-slot claim lost");
      }
      return { ...legacy, activeOwnerKey: ownerUserId };
    }

    return await tx.topUpCheckoutAttempt.create({
      data: {
        id: proposedAttemptId,
        ownerUserId,
        activeOwnerKey: ownerUserId,
        checkoutKey,
        stripeCustomerId,
        billingOfferId,
        status: "open",
        expiresAt,
        paramsJson,
      },
    });
  };
  if (prisma) return await run(prisma);
  for (let attempt = 0; ; attempt++) {
    try {
      return await startRetryableTransaction(run);
    } catch (error) {
      if (!isUniqueViolation(error) || attempt >= 4) throw error;
    }
  }
}

export type TopUpCheckoutCreationClaim =
  | { status: "claimed"; attempt: NonNullable<Awaited<ReturnType<typeof findTopUpCheckoutAttempt>>> }
  | { status: "busy" };

export async function claimTopUpCheckoutCreation({
  attemptId,
  ownerUserId,
  now,
  leaseToken,
  leaseExpiresAt,
  prisma,
}: {
  attemptId: string;
  ownerUserId: string;
  now: Date;
  leaseToken: string;
  leaseExpiresAt: Date;
  prisma?: PrismaTransaction;
}): Promise<TopUpCheckoutCreationClaim> {
  const db = prisma ?? await getDb();
  const claimed = await db.topUpCheckoutAttempt.updateMany({
    where: {
      id: attemptId,
      ownerUserId,
      activeOwnerKey: ownerUserId,
      accountDeletionAt: null,
      recoveryInterventionAt: null,
      stripeCheckoutSessionId: null,
      status: { in: ["open", "payment_pending"] },
      OR: [
        { createLeaseExpiresAt: null },
        { createLeaseExpiresAt: { lte: now } },
      ],
    },
    data: { createLeaseToken: leaseToken, createLeaseExpiresAt: leaseExpiresAt },
  });
  if (claimed.count !== 1) return { status: "busy" };
  const attempt = await findTopUpCheckoutAttempt({ attemptId, prisma: db });
  if (!attempt) throw new Error("Claimed top-up checkout attempt disappeared");
  return { status: "claimed", attempt };
}

export async function releaseTopUpCheckoutCreation({
  attemptId,
  leaseToken,
  lastError,
  notBefore,
  prisma,
}: {
  attemptId: string;
  leaseToken: string;
  lastError?: string;
  notBefore?: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.topUpCheckoutAttempt.updateMany({
    where: { id: attemptId, createLeaseToken: leaseToken },
    data: {
      createLeaseToken: null,
      createLeaseExpiresAt: null,
      recoveryLeaseToken: null,
      recoveryLeaseExpiresAt: null,
      recoveryNotBefore: notBefore ?? null,
      recoveryLastError: lastError ?? null,
    },
  });
}

export async function bindTopUpCheckoutCreation({
  attemptId,
  leaseToken,
  stripeCheckoutSessionId,
  expiresAt,
  prisma,
}: {
  attemptId: string;
  leaseToken: string;
  stripeCheckoutSessionId: string;
  expiresAt: Date;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    const normal = await tx.topUpCheckoutAttempt.updateMany({
      where: {
        id: attemptId,
        status: { in: ["open", "payment_pending"] },
        accountDeletionAt: null,
        stripeCheckoutSessionId: null,
        createLeaseToken: leaseToken,
      },
      data: {
        stripeCheckoutSessionId,
        expiresAt,
        createLeaseToken: null,
        createLeaseExpiresAt: null,
        recoveryLastError: null,
      },
    });
    if (normal.count === 1) return "stored-for-checkout" as const;

    const refund = await tx.topUpCheckoutAttempt.updateMany({
      where: {
        id: attemptId,
        status: "refund_required",
        accountDeletionAt: { not: null },
        stripeCheckoutSessionId: null,
        createLeaseToken: leaseToken,
      },
      data: {
        stripeCheckoutSessionId,
        expiresAt,
        createLeaseToken: null,
        createLeaseExpiresAt: null,
        refundNotBefore: new Date(),
      },
    });
    return refund.count === 1 ? "stored-for-refund" as const : "not-stored" as const;
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

export async function expireTopUpCheckoutAttempt({
  attemptId,
  ownerUserId,
  stripeCheckoutSessionId,
  leaseToken,
  prisma,
}: {
  attemptId: string;
  ownerUserId: string;
  stripeCheckoutSessionId?: string | null;
  leaseToken?: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.topUpCheckoutAttempt.updateMany({
    where: {
      id: attemptId,
      ownerUserId,
      activeOwnerKey: ownerUserId,
      accountDeletionAt: null,
      status: { in: ["open", "payment_pending"] },
      ...(stripeCheckoutSessionId === undefined
        ? {}
        : { stripeCheckoutSessionId }),
      ...(leaseToken === undefined ? {} : { createLeaseToken: leaseToken }),
    },
    data: {
      status: "expired",
      activeOwnerKey: null,
      createLeaseToken: null,
      createLeaseExpiresAt: null,
      recoveryLeaseToken: null,
      recoveryLeaseExpiresAt: null,
      recoveryNotBefore: null,
    },
  });
}

export async function setTopUpCheckoutSession({
  attemptId,
  stripeCheckoutSessionId,
  expiresAt,
  prisma,
}: {
  attemptId: string;
  stripeCheckoutSessionId: string;
  expiresAt: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  const open = await db.topUpCheckoutAttempt.updateMany({
    where: { id: attemptId, status: "open", stripeCheckoutSessionId: null },
    data: {
      stripeCheckoutSessionId,
      expiresAt,
      createLeaseToken: null,
      createLeaseExpiresAt: null,
      recoveryLeaseToken: null,
      recoveryLeaseExpiresAt: null,
      recoveryNotBefore: null,
    },
  });
  if (open.count === 1) {
    return "stored-for-checkout" as const;
  }

  // Account deletion can race the Stripe create call. Preserve the Session so
  // the refund processor can expire it, but tell checkout not to redirect.
  const refund = await db.topUpCheckoutAttempt.updateMany({
    where: {
      id: attemptId,
      status: "refund_required",
      accountDeletionAt: { not: null },
      stripeCheckoutSessionId: null,
    },
    data: {
      stripeCheckoutSessionId,
      expiresAt,
      createLeaseToken: null,
      createLeaseExpiresAt: null,
      recoveryLeaseToken: null,
      recoveryLeaseExpiresAt: null,
      recoveryNotBefore: null,
    },
  });
  if (refund.count === 1) return "stored-for-refund" as const;

  const current = await db.topUpCheckoutAttempt.findUnique({
    where: { id: attemptId },
    select: { stripeCheckoutSessionId: true },
  });
  return current?.stripeCheckoutSessionId === stripeCheckoutSessionId
    ? "already-bound" as const
    : "not-stored" as const;
}

export async function claimUnboundTopUpCheckoutRecoveries({ now, leaseToken, leaseExpiresAt, limit = 50, prisma }: { now: Date; leaseToken: string; leaseExpiresAt: Date; limit?: number; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  const rows = await db.topUpCheckoutAttempt.findMany({ where: { recoveryInterventionAt: null, stripeCheckoutSessionId: null, status: { notIn: ["fulfilled", "refunded", "refund_not_required", "expired"] }, AND: [{ OR: [{ recoveryLeaseExpiresAt: null }, { recoveryLeaseExpiresAt: { lte: now } }] }, { OR: [{ recoveryNotBefore: null }, { recoveryNotBefore: { lte: now } }] }, { OR: [{ createLeaseExpiresAt: null }, { createLeaseExpiresAt: { lte: now } }] }] }, take: limit });
  const claimed = [];
  for (const row of rows) {
    const updated = await db.topUpCheckoutAttempt.updateMany({ where: { id: row.id, status: row.status, recoveryInterventionAt: null, stripeCheckoutSessionId: null, recoveryLeaseToken: row.recoveryLeaseToken, createLeaseToken: row.createLeaseToken, AND: [{ OR: [{ recoveryLeaseExpiresAt: null }, { recoveryLeaseExpiresAt: { lte: now } }] }, { OR: [{ createLeaseExpiresAt: null }, { createLeaseExpiresAt: { lte: now } }] }] }, data: { recoveryLeaseToken: leaseToken, recoveryLeaseExpiresAt: leaseExpiresAt, createLeaseToken: leaseToken, createLeaseExpiresAt: leaseExpiresAt, recoveryAttempts: { increment: 1 } } });
    if (updated.count === 1) claimed.push({ ...row, recoveryLeaseToken: leaseToken, recoveryLeaseExpiresAt: leaseExpiresAt, createLeaseToken: leaseToken, createLeaseExpiresAt: leaseExpiresAt, recoveryAttempts: row.recoveryAttempts + 1 });
  }
  return claimed;
}

export async function clearDetachedTopUpCheckoutRecovery({ attemptId, leaseToken, lastError, notBefore, prisma }: { attemptId: string; leaseToken: string; lastError?: string; notBefore?: Date; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.topUpCheckoutAttempt.updateMany({ where: { id: attemptId, recoveryLeaseToken: leaseToken, createLeaseToken: leaseToken }, data: { recoveryLeaseToken: null, recoveryLeaseExpiresAt: null, createLeaseToken: null, createLeaseExpiresAt: null, recoveryLastError: lastError ?? null, recoveryNotBefore: lastError ? (notBefore ?? new Date()) : null } });
}

export async function completeDetachedTopUpCheckoutRecovery({ attemptId, leaseToken, stripeCheckoutSessionId, expiresAt, prisma }: { attemptId: string; leaseToken: string; stripeCheckoutSessionId: string; expiresAt: Date; prisma?: PrismaTransaction }) {
  const run = async (tx: PrismaTransaction) => {
    const attempt = await tx.topUpCheckoutAttempt.findUnique({ where: { id: attemptId } });
    if (!attempt || attempt.recoveryLeaseToken !== leaseToken || attempt.createLeaseToken !== leaseToken || attempt.stripeCheckoutSessionId !== null) return "not-stored" as const;
    const stored = await tx.topUpCheckoutAttempt.updateMany({ where: { id: attemptId, recoveryLeaseToken: leaseToken, createLeaseToken: leaseToken, stripeCheckoutSessionId: null, updatedAt: attempt.updatedAt }, data: { stripeCheckoutSessionId, expiresAt, status: attempt.accountDeletionAt === null ? attempt.status : "refund_required", ...(attempt.accountDeletionAt === null ? {} : { refundNotBefore: new Date() }), recoveryLeaseToken: null, recoveryLeaseExpiresAt: null, createLeaseToken: null, createLeaseExpiresAt: null, recoveryNotBefore: null, recoveryLastError: null } });
    if (stored.count !== 1) return "not-stored" as const;
    return attempt.accountDeletionAt === null ? "stored-for-checkout" as const : "stored-for-refund" as const;
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

export async function markDetachedTopUpCheckoutRecoveryIntervention({ attemptId, leaseToken, lastError, prisma }: { attemptId: string; leaseToken: string; lastError: string; prisma?: PrismaTransaction }) {
  const run = async (tx: PrismaTransaction) => {
    const attempt = await tx.topUpCheckoutAttempt.findUnique({ where: { id: attemptId } });
    if (!attempt || attempt.recoveryLeaseToken !== leaseToken || attempt.createLeaseToken !== leaseToken) return { count: 0 };
    const interventionAt = new Date();
    const updated = await tx.topUpCheckoutAttempt.updateMany({ where: { id: attemptId, recoveryLeaseToken: leaseToken, createLeaseToken: leaseToken, updatedAt: attempt.updatedAt }, data: { recoveryInterventionAt: interventionAt, recoveryLastError: lastError, recoveryLeaseToken: null, recoveryLeaseExpiresAt: null, createLeaseToken: null, createLeaseExpiresAt: null } });
    if (updated.count !== 1) return { count: 0 };
    const existing = await tx.topUpCheckoutResolution.findUnique({ where: { topUpAttemptId: attemptId } });
    if (!existing) {
      await tx.topUpCheckoutResolution.create({ data: {
        topUpAttemptId: attemptId,
        ownerUserId: attempt.ownerUserId,
        stripeCustomerId: attempt.stripeCustomerId,
        billingOfferId: attempt.billingOfferId,
        canonicalSessionId: null,
        canonicalPaymentIntentId: attempt.stripePaymentIntentId,
        expectedPaymentIntentIds: "[]",
        status: "intervention",
        lastError,
      } });
    } else {
      const resolutionUpdated = await tx.topUpCheckoutResolution.updateMany({
        where: { id: existing.id, topUpAttemptId: attemptId, revision: existing.revision },
        data: { status: "intervention", lastError, revision: { increment: 1 } },
      });
      if (resolutionUpdated.count !== 1) {
        throw new Error("Top-up detached intervention resolution CAS lost");
      }
    }
    return { count: 1 };
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

export async function markDetachedTopUpCheckoutRecoveryTerminal({ attemptId, leaseToken, prisma }: { attemptId: string; leaseToken: string; prisma?: PrismaTransaction }) {
  const run = async (tx: PrismaTransaction) => {
    const attempt = await tx.topUpCheckoutAttempt.findUnique({ where: { id: attemptId } });
    if (!attempt || attempt.recoveryLeaseToken !== leaseToken || attempt.createLeaseToken !== leaseToken || attempt.stripeCheckoutSessionId !== null) return { count: 0 };
    return await tx.topUpCheckoutAttempt.updateMany({ where: { id: attemptId, recoveryLeaseToken: leaseToken, createLeaseToken: leaseToken, stripeCheckoutSessionId: null, updatedAt: attempt.updatedAt }, data: { status: attempt.accountDeletionAt === null ? "expired" : "refund_not_required", activeOwnerKey: null, recoveryLeaseToken: null, recoveryLeaseExpiresAt: null, createLeaseToken: null, createLeaseExpiresAt: null, recoveryNotBefore: null } });
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

export async function findTopUpCheckoutAttempt({
  attemptId,
  prisma,
}: {
  attemptId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.topUpCheckoutAttempt.findUnique({
    where: { id: attemptId },
    include: { billingOffer: true },
  });
}

export async function findTopUpCheckoutAttemptBySessionId({
  stripeCheckoutSessionId,
  prisma,
}: {
  stripeCheckoutSessionId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.topUpCheckoutAttempt.findUnique({
    where: { stripeCheckoutSessionId },
    include: { billingOffer: true },
  });
}

export async function findTopUpCheckoutAttemptByPaymentIntentId({
  stripePaymentIntentId,
  prisma,
}: {
  stripePaymentIntentId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.topUpCheckoutAttempt.findUnique({
    where: { stripePaymentIntentId },
    include: { billingOffer: true },
  });
}

export async function fulfillTopUpCheckoutAttempt({
  attemptId,
  stripePaymentIntentId,
  stripePayment,
  stripeRefundState,
  now = new Date(),
  prisma,
}: {
  attemptId: string;
  stripePaymentIntentId: string;
  stripePayment: StripePaymentDetails;
  stripeRefundState: {
    succeededAmount: number;
    pendingAmount: number;
  };
  now?: Date;
  prisma?: PrismaTransaction;
}): Promise<
  | { status: "fulfilled" | "already-fulfilled"; userId: string; creditAmount: number }
  | { status: "refund-required" }
  | { status: "duplicate-refund-required" }
  | { status: "recovery-pending" }
  | { status: "invalid" }
> {
  const run = async (tx: PrismaTransaction) => {
    const attempt = await tx.topUpCheckoutAttempt.findUnique({
      where: { id: attemptId },
      include: { billingOffer: true },
    });
    if (!attempt || attempt.billingOffer.kind !== "top_up") {
      return { status: "invalid" as const };
    }
    if (
      attempt.billingOffer.unitAmount !== stripePayment.amount ||
      attempt.billingOffer.currency.toLowerCase() !==
        stripePayment.currency.toLowerCase() ||
      !Number.isSafeInteger(attempt.billingOffer.creditAmount) ||
      (attempt.billingOffer.creditAmount ?? 0) <= 0
    ) {
      return { status: "invalid" as const };
    }
    if (
      !Number.isSafeInteger(stripeRefundState.succeededAmount) ||
      !Number.isSafeInteger(stripeRefundState.pendingAmount) ||
      stripeRefundState.succeededAmount < 0 ||
      stripeRefundState.pendingAmount < 0 ||
      stripeRefundState.succeededAmount + stripeRefundState.pendingAmount >
        stripePayment.amount
    ) {
      return { status: "invalid" as const };
    }
    if (
      attempt.stripePaymentIntentId !== null &&
      attempt.stripePaymentIntentId !== stripePaymentIntentId
    ) {
      await scheduleTopUpDuplicateRefundAttempt({
        topUpAttemptId: attempt.id,
        stripePaymentIntentId,
        stripeCustomerId: attempt.stripeCustomerId,
        ownerUserId: attempt.ownerUserId,
        billingOfferId: attempt.billingOfferId,
        amount: stripePayment.amount,
        currency: stripePayment.currency,
        prisma: tx,
      });
      return { status: "duplicate-refund-required" as const };
    }
    if (attempt.status === "fulfilled") {
      return {
        status: "already-fulfilled" as const,
        userId: attempt.ownerUserId,
        creditAmount: attempt.billingOffer.creditAmount!,
      };
    }
    if (
      attempt.accountDeletionAt !== null ||
      attempt.status === "refund_required" ||
      attempt.status === "refund_pending" ||
      attempt.status === "refunded" ||
      attempt.status === "refund_failed" ||
      attempt.status === "refund_not_required" ||
      attempt.status === "expired"
    ) {
      return { status: "refund-required" as const };
    }

    const resolution = await tx.topUpCheckoutResolution.findUnique({
      where: { topUpAttemptId: attempt.id },
    });
    if (resolution) {
      if (resolution.canonicalPaymentIntentId !== stripePaymentIntentId) {
        await scheduleTopUpDuplicateRefundAttempt({
          topUpAttemptId: attempt.id,
          stripePaymentIntentId,
          stripeCustomerId: attempt.stripeCustomerId,
          ownerUserId: attempt.ownerUserId,
          billingOfferId: attempt.billingOfferId,
          amount: stripePayment.amount,
          currency: stripePayment.currency,
          prisma: tx,
        });
        return { status: "duplicate-refund-required" as const };
      }
      if (resolution.status !== "resolved") {
        return { status: "recovery-pending" as const };
      }
    }
    if (
      attempt.createLeaseToken !== null ||
      attempt.recoveryLeaseToken !== null
    ) {
      return { status: "recovery-pending" as const };
    }
    if (
      stripeRefundState.succeededAmount > 0 ||
      stripeRefundState.pendingAmount > 0
    ) {
      return { status: "refund-required" as const };
    }

    const [user, deletionIntent] = await Promise.all([
      tx.user.findUnique({
        where: { id: attempt.ownerUserId },
        select: { id: true },
      }),
      tx.accountDeletionIntent.findFirst({
        where: { userId: attempt.ownerUserId, expiresAt: { gt: now } },
        select: { userId: true },
      }),
    ]);
    if (!user || deletionIntent) {
      const updated = await tx.topUpCheckoutAttempt.updateMany({
        where: {
          id: attempt.id,
          status: { in: ["open", "payment_pending"] },
          updatedAt: attempt.updatedAt,
          OR: [
            { stripePaymentIntentId: null },
            { stripePaymentIntentId },
          ],
        },
        data: {
          stripePaymentIntentId,
          status: "refund_required",
          accountDeletionAt: attempt.accountDeletionAt ?? now,
          refundNotBefore: now,
          createLeaseToken: null,
          createLeaseExpiresAt: null,
          recoveryLeaseToken: null,
          recoveryLeaseExpiresAt: null,
          recoveryNotBefore: null,
        },
      });
      if (updated.count !== 1) {
        const current = await tx.topUpCheckoutAttempt.findUnique({
          where: { id: attempt.id },
          select: { status: true },
        });
        if (
          current?.status !== "refunded" &&
          current?.status !== "refund_not_required" &&
          !isRefundProcessingStatus(current?.status ?? "")
        ) {
          throw new Error("Top-up checkout ownership changed during refund scheduling");
        }
      }
      return { status: "refund-required" as const };
    }

    await addPurchasedCredits({
      userId: attempt.ownerUserId,
      amount: attempt.billingOffer.creditAmount!,
      stripePaymentId: stripePaymentIntentId,
      stripePayment,
      billingOfferId: attempt.billingOfferId,
      topUpCheckoutAttemptId: attempt.id,
      prisma: tx,
    });
    const updated = await tx.topUpCheckoutAttempt.updateMany({
      where: {
        id: attempt.id,
        status: { in: ["open", "payment_pending"] },
        accountDeletionAt: null,
        updatedAt: attempt.updatedAt,
      },
      data: {
        stripePaymentIntentId,
        status: "fulfilled",
        fulfilledAt: now,
        activeOwnerKey: null,
        createLeaseToken: null,
        createLeaseExpiresAt: null,
        recoveryLeaseToken: null,
        recoveryLeaseExpiresAt: null,
        recoveryNotBefore: null,
      },
    });
    if (updated.count !== 1) {
      throw new Error("Top-up checkout ownership changed during fulfillment");
    }
    return {
      status: "fulfilled" as const,
      userId: attempt.ownerUserId,
      creditAmount: attempt.billingOffer.creditAmount!,
    };
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

export async function requireTopUpRefund({
  attemptId,
  stripePaymentIntentId,
  now = new Date(),
  prisma,
}: {
  attemptId: string;
  stripePaymentIntentId: string;
  now?: Date;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    const attempt = await tx.topUpCheckoutAttempt.findUnique({
      where: { id: attemptId },
    });
    if (
      !attempt ||
      NON_REOPENABLE_REFUND_STATUSES.has(attempt.status) ||
      (attempt.stripePaymentIntentId !== null &&
        attempt.stripePaymentIntentId !== stripePaymentIntentId)
    ) {
      return { count: 0 };
    }

    const status = isRefundProcessingStatus(attempt.status)
      ? attempt.status
      : "refund_required";
    return await tx.topUpCheckoutAttempt.updateMany({
      where: {
        id: attemptId,
        status: attempt.status,
        updatedAt: attempt.updatedAt,
        OR: [
          { stripePaymentIntentId: null },
          { stripePaymentIntentId },
        ],
      },
      data: {
        stripePaymentIntentId,
        status,
        accountDeletionAt: attempt.accountDeletionAt ?? now,
        refundNotBefore: attempt.refundInterventionAt === null
          ? now
          : attempt.refundNotBefore,
        ...(attempt.status === "refund_not_required" || attempt.status === "expired"
          ? {
              refundId: null,
              refundStatus: null,
              refundStatusObservedAt: null,
              refundTargetAmount: null,
              refundSucceededAmount: 0,
              refundPendingAmount: 0,
              refundCurrency: null,
              refundAttempts: 0,
              refundLastError: null,
              refundInterventionAt: null,
              refundLeaseToken: null,
              refundLeaseExpiresAt: null,
            }
          : {}),
      },
    });
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

export async function recordTopUpRefund({
  attemptId,
  stripePaymentIntentId,
  refundId,
  refundStatus,
  refundTargetAmount,
  refundSucceededAmount,
  refundPendingAmount,
  refundCurrency,
  now = new Date(),
  refundLeaseToken,
  prisma,
}: {
  attemptId: string;
  stripePaymentIntentId: string;
  refundId: string | null;
  refundStatus: string | null;
  refundTargetAmount: number;
  refundSucceededAmount: number;
  refundPendingAmount: number;
  refundCurrency: string;
  now?: Date;
  refundLeaseToken?: string;
  prisma?: PrismaTransaction;
}) {
  if (
    !Number.isSafeInteger(refundTargetAmount) ||
    !Number.isSafeInteger(refundSucceededAmount) ||
    !Number.isSafeInteger(refundPendingAmount) ||
    refundTargetAmount <= 0 ||
    refundSucceededAmount < 0 ||
    refundPendingAmount < 0 ||
    refundSucceededAmount + refundPendingAmount > refundTargetAmount
  ) {
    throw new RangeError("Canonical top-up refund amounts are invalid");
  }
  const normalizedCurrency = refundCurrency.toLowerCase();
  if (normalizedCurrency.length === 0) {
    throw new RangeError("Canonical top-up refund currency is required");
  }

  const run = async (tx: PrismaTransaction) => {
    for (let attemptNumber = 0; attemptNumber < 8; attemptNumber++) {
      const attempt = await tx.topUpCheckoutAttempt.findUnique({
        where: { id: attemptId },
      });
      if (
        !attempt ||
        attempt.status === "fulfilled" ||
        (refundLeaseToken !== undefined &&
          attempt.refundLeaseToken !== refundLeaseToken)
      ) {
        return { count: 0 };
      }
      if (
        (attempt.stripePaymentIntentId !== null &&
          attempt.stripePaymentIntentId !== stripePaymentIntentId) ||
        (attempt.refundTargetAmount !== null &&
          attempt.refundTargetAmount !== refundTargetAmount) ||
        (attempt.refundCurrency !== null &&
          attempt.refundCurrency !== normalizedCurrency)
      ) {
        throw new Error(`Top-up refund ${attemptId} conflicts with Stripe`);
      }

      const reopening = attempt.status === "refund_not_required" ||
        attempt.status === "expired";
      const fullyRefunded = refundSucceededAmount === refundTargetAmount;
      if (attempt.status === "refunded") {
        return { count: 0 };
      }
      if (refundSucceededAmount < attempt.refundSucceededAmount) {
        return { count: 0 };
      }
      if (
        refundId !== null &&
        attempt.refundId === refundId &&
        (attempt.refundStatus === "failed" ||
          attempt.refundStatus === "canceled") &&
        refundStatus !== "failed" &&
        refundStatus !== "canceled"
      ) {
        return { count: 0 };
      }

      const status = fullyRefunded
        ? "refunded"
        : attempt.refundInterventionAt !== null && !reopening
          ? attempt.status
          : refundStatus === "failed" || refundStatus === "canceled"
            ? "refund_failed"
          : refundPendingAmount > 0
            ? "refund_pending"
            : "refund_required";
      const updated = await tx.topUpCheckoutAttempt.updateMany({
        where: {
          id: attempt.id,
          status: attempt.status,
          updatedAt: attempt.updatedAt,
          ...(refundLeaseToken === undefined ? {} : { refundLeaseToken }),
        },
        data: {
          stripePaymentIntentId,
          accountDeletionAt: attempt.accountDeletionAt ?? now,
          refundTargetAmount,
          refundSucceededAmount,
          refundPendingAmount,
          refundCurrency: normalizedCurrency,
          ...(reopening
            ? {
                refundId: null,
                refundStatus: null,
                refundStatusObservedAt: null,
                refundAttempts: 0,
                refundLastError: null,
                refundInterventionAt: null,
                refundLeaseToken: null,
                refundLeaseExpiresAt: null,
              }
            : {}),
          ...(refundId === null
            ? {}
            : {
                refundId,
                refundStatus,
                refundStatusObservedAt: now,
              }),
          status,
          ...(fullyRefunded
            ? {
                activeOwnerKey: null,
                recoveryInterventionAt: null,
                recoveryAttempts: 0,
                recoveryLastError: null,
                recoveryNotBefore: null,
                refundNotBefore: null,
                refundLeaseToken: null,
                refundLeaseExpiresAt: null,
                refundLastError: null,
                refundInterventionAt: null,
              }
            : attempt.refundInterventionAt === null || reopening
              ? { refundNotBefore: now }
              : {}),
        },
      });
      if (updated.count === 1) {
        if (fullyRefunded) {
          const resolution = await tx.topUpCheckoutResolution.findUnique({
            where: { topUpAttemptId: attempt.id },
          });
          if (
            resolution &&
            ["refund_pending", "intervention"].includes(resolution.status) &&
            await expectedDuplicateRefundsAreSettled(
              tx,
              resolution.expectedPaymentIntentIds,
            )
          ) {
            const canonicalMatches =
              (!resolution.canonicalSessionId ||
                resolution.canonicalSessionId === attempt.stripeCheckoutSessionId) &&
              (!resolution.canonicalPaymentIntentId ||
                resolution.canonicalPaymentIntentId === stripePaymentIntentId);
            const settled = await tx.topUpCheckoutResolution.updateMany({
              where: {
                id: resolution.id,
                topUpAttemptId: attempt.id,
                revision: resolution.revision,
                status: resolution.status,
              },
              data: {
                status: canonicalMatches ? "terminal" : "intervention",
                lastError: canonicalMatches
                  ? null
                  : "Main refund settled a different canonical Stripe identity",
                revision: { increment: 1 },
              },
            });
            if (settled.count !== 1) {
              throw new Error("Top-up main refund resolution CAS lost");
            }
          }
        }
        return updated;
      }
    }
    throw new Error("Top-up refund changed concurrently");
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

export async function listDueTopUpRefundAttempts({
  now,
  limit = 50,
  prisma,
}: {
  now: Date;
  limit?: number;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.topUpCheckoutAttempt.findMany({
    where: {
      status: { in: [...TOP_UP_REFUND_PROCESSING_STATUSES] },
      refundInterventionAt: null,
      AND: [
        {
          OR: [
            { refundNotBefore: null },
            { refundNotBefore: { lte: now } },
          ],
        },
        {
          OR: [
            { refundLeaseExpiresAt: null },
            { refundLeaseExpiresAt: { lte: now } },
          ],
        },
      ],
    },
    orderBy: [{ refundNotBefore: "asc" }, { createdAt: "asc" }],
    take: limit,
  });
}

export async function claimTopUpRefundAttempt({
  attemptId,
  now,
  leaseToken,
  leaseExpiresAt,
  maxAttempts,
  prisma,
}: {
  attemptId: string;
  now: Date;
  leaseToken: string;
  leaseExpiresAt: Date;
  maxAttempts: number;
  prisma?: PrismaTransaction;
}) {
  if (leaseExpiresAt.getTime() <= now.getTime()) {
    throw new Error("Top-up refund lease must expire after it starts");
  }
  if (maxAttempts < 1) {
    throw new Error("Top-up refund max attempts must be positive");
  }

  const run = async (tx: PrismaTransaction) => {
    const attempt = await tx.topUpCheckoutAttempt.findUnique({
      where: { id: attemptId },
    });
    const due = attempt?.refundNotBefore === null ||
      (attempt?.refundNotBefore !== undefined &&
        attempt.refundNotBefore.getTime() <= now.getTime());
    const leaseAvailable = attempt?.refundLeaseExpiresAt === null ||
      (attempt?.refundLeaseExpiresAt !== undefined &&
        attempt.refundLeaseExpiresAt.getTime() <= now.getTime());
    if (
      !attempt ||
      !isRefundProcessingStatus(attempt.status) ||
      attempt.refundInterventionAt !== null ||
      !due ||
      !leaseAvailable
    ) {
      return { outcome: "not-claimed" as const };
    }

    if (attempt.refundAttempts >= maxAttempts) {
      const escalated = await tx.topUpCheckoutAttempt.updateMany({
        where: {
          id: attempt.id,
          status: attempt.status,
          updatedAt: attempt.updatedAt,
          refundInterventionAt: null,
        },
        data: {
          refundInterventionAt: now,
          refundNotBefore: null,
          refundLeaseToken: null,
          refundLeaseExpiresAt: null,
          refundLastError: attempt.refundLastError ??
            `Automatic refund processing exhausted ${maxAttempts} attempts`,
        },
      });
      return escalated.count === 1
        ? { outcome: "intervention-required" as const }
        : { outcome: "not-claimed" as const };
    }

    const claimed = await tx.topUpCheckoutAttempt.updateMany({
      where: {
        id: attempt.id,
        status: attempt.status,
        updatedAt: attempt.updatedAt,
        refundInterventionAt: null,
      },
      data: {
        refundLeaseToken: leaseToken,
        refundLeaseExpiresAt: leaseExpiresAt,
        refundAttempts: { increment: 1 },
      },
    });
    if (claimed.count !== 1) {
      return { outcome: "not-claimed" as const };
    }
    const result = await tx.topUpCheckoutAttempt.findUnique({
      where: { id: attempt.id },
    });
    if (!result) {
      throw new Error("Claimed top-up refund disappeared");
    }
    return { outcome: "claimed" as const, attempt: result };
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

export async function attachTopUpRefundPaymentIntent({
  attemptId,
  stripePaymentIntentId,
  refundLeaseToken,
  prisma,
}: {
  attemptId: string;
  stripePaymentIntentId: string;
  refundLeaseToken: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  const updated = await db.topUpCheckoutAttempt.updateMany({
    where: {
      id: attemptId,
      status: { in: [...TOP_UP_REFUND_PROCESSING_STATUSES] },
      refundLeaseToken,
      refundInterventionAt: null,
      OR: [
        { stripePaymentIntentId: null },
        { stripePaymentIntentId },
      ],
    },
    data: { stripePaymentIntentId },
  });
  return updated.count === 1;
}

export async function attachTopUpRefundId({
  attemptId,
  stripePaymentIntentId,
  refundId,
  refundLeaseToken,
  prisma,
}: {
  attemptId: string;
  stripePaymentIntentId: string;
  refundId: string;
  refundLeaseToken: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  const updated = await db.topUpCheckoutAttempt.updateMany({
    where: {
      id: attemptId,
      status: { in: [...TOP_UP_REFUND_PROCESSING_STATUSES] },
      stripePaymentIntentId,
      refundLeaseToken,
      refundInterventionAt: null,
    },
    data: { refundId },
  });
  return updated.count === 1;
}

export async function rescheduleTopUpRefundAttempt({
  attemptId,
  refundLeaseToken,
  refundNotBefore,
  refundLastError,
  prisma,
}: {
  attemptId: string;
  refundLeaseToken: string;
  refundNotBefore: Date;
  refundLastError: string | null;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  const updated = await db.topUpCheckoutAttempt.updateMany({
    where: {
      id: attemptId,
      status: { in: [...TOP_UP_REFUND_PROCESSING_STATUSES] },
      refundLeaseToken,
      refundInterventionAt: null,
    },
    data: {
      refundNotBefore,
      refundLeaseToken: null,
      refundLeaseExpiresAt: null,
      refundLastError,
    },
  });
  return updated.count === 1;
}

export async function markTopUpRefundInterventionRequired({
  attemptId,
  refundLeaseToken,
  now,
  reason,
  prisma,
}: {
  attemptId: string;
  refundLeaseToken: string;
  now: Date;
  reason: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  const updated = await db.topUpCheckoutAttempt.updateMany({
    where: {
      id: attemptId,
      status: { in: [...TOP_UP_REFUND_PROCESSING_STATUSES] },
      refundLeaseToken,
      refundInterventionAt: null,
    },
    data: {
      refundInterventionAt: now,
      refundNotBefore: null,
      refundLeaseToken: null,
      refundLeaseExpiresAt: null,
      refundLastError: reason,
    },
  });
  return updated.count === 1;
}

export async function markTopUpRefundNotRequired({
  attemptId,
  refundLeaseToken,
  now,
  prisma,
}: {
  attemptId: string;
  refundLeaseToken: string;
  now: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  const updated = await db.topUpCheckoutAttempt.updateMany({
    where: {
      id: attemptId,
      status: "refund_required",
      stripePaymentIntentId: null,
      refundId: null,
      accountDeletionAt: { not: null },
      refundLeaseToken,
      refundInterventionAt: null,
    },
    data: {
      status: "refund_not_required",
      activeOwnerKey: null,
      refundStatus: "not_required",
      refundStatusObservedAt: now,
      refundNotBefore: null,
      refundLeaseToken: null,
      refundLeaseExpiresAt: null,
      refundLastError: null,
    },
  });
  return updated.count === 1;
}

export async function prepareTopUpsForAccountDeletion({
  ownerUserId,
  now,
  prisma,
}: {
  ownerUserId: string;
  now: Date;
  prisma: PrismaTransaction;
}) {
  const alreadyRequired = await prisma.topUpCheckoutAttempt.updateMany({
    where: {
      ownerUserId,
      status: { in: [...TOP_UP_REFUND_PROCESSING_STATUSES] },
      refundInterventionAt: null,
    },
    data: {
      accountDeletionAt: now,
      refundNotBefore: now,
    },
  });
  const newlyRequired = await prisma.topUpCheckoutAttempt.updateMany({
    where: {
      ownerUserId,
      status: { in: ["open", "payment_pending"] },
    },
    data: {
      status: "refund_required",
      accountDeletionAt: now,
      refundNotBefore: now,
    },
  });
  // Operator interventions are intentionally retained through account
  // deletion. They represent an unresolved remote-money question and must
  // remain actionable; clearing the marker would make the deletion worker
  // silently skip the row and could strand a refundable PaymentIntent.
  const resolutions = await prisma.topUpCheckoutResolution.findMany({
    where: { ownerUserId, status: { in: ["refund_pending", "intervention"] } },
    select: {
      id: true,
      topUpAttemptId: true,
      revision: true,
      status: true,
      canonicalSessionId: true,
      canonicalPaymentIntentId: true,
      expectedPaymentIntentIds: true,
    },
  });
  for (const resolution of resolutions) {
    const attempt = await prisma.topUpCheckoutAttempt.findUnique({
      where: { id: resolution.topUpAttemptId },
      select: {
        id: true,
        ownerUserId: true,
        stripeCheckoutSessionId: true,
        stripePaymentIntentId: true,
        status: true,
        fulfilledAt: true,
        refundTargetAmount: true,
        refundSucceededAmount: true,
        refundPendingAmount: true,
        recoveryInterventionAt: true,
        updatedAt: true,
      },
    });
    if (!attempt || attempt.ownerUserId !== ownerUserId) {
      if (resolution.status !== "intervention") {
        const held = await prisma.topUpCheckoutResolution.updateMany({
          where: { id: resolution.id, topUpAttemptId: resolution.topUpAttemptId, ownerUserId, revision: resolution.revision, status: "refund_pending" },
          data: { status: "intervention", lastError: "Orphaned top-up resolution requires operator Stripe evidence", revision: { increment: 1 } },
        });
        if (held.count !== 1) throw new Error("Top-up deletion orphan intervention CAS lost");
      }
    } else if (
      ["refund_pending", "intervention"].includes(resolution.status) &&
      await expectedDuplicateRefundsAreSettled(
        prisma,
        resolution.expectedPaymentIntentIds,
      )
    ) {
      let nextStatus: "resolved" | "terminal" | null = null;
      const canonicalMatches =
        (!resolution.canonicalSessionId ||
          resolution.canonicalSessionId === attempt.stripeCheckoutSessionId) &&
        (!resolution.canonicalPaymentIntentId ||
          resolution.canonicalPaymentIntentId === attempt.stripePaymentIntentId);
      const mainRefundIsFull = attempt.status === "refunded" &&
        (attempt.refundTargetAmount ?? 0) > 0 &&
        attempt.refundSucceededAmount === attempt.refundTargetAmount &&
        attempt.refundPendingAmount === 0;
      if (mainRefundIsFull && canonicalMatches) {
        nextStatus = "terminal";
      } else if (
        attempt.status === "fulfilled" &&
        attempt.fulfilledAt !== null &&
        attempt.stripePaymentIntentId !== null &&
        (!resolution.canonicalSessionId ||
          resolution.canonicalSessionId === attempt.stripeCheckoutSessionId) &&
        (!resolution.canonicalPaymentIntentId ||
          resolution.canonicalPaymentIntentId === attempt.stripePaymentIntentId)
      ) {
        const purchase = await prisma.creditTransaction.findFirst({
          where: {
            topUpCheckoutAttemptId: attempt.id,
            stripePaymentId: attempt.stripePaymentIntentId,
          },
          select: { id: true },
        });
        if (purchase) nextStatus = "resolved";
      }
      if (
        attempt.status === "refunded" &&
        nextStatus === null &&
        resolution.status !== "intervention"
      ) {
        const held = await prisma.topUpCheckoutResolution.updateMany({
          where: {
            id: resolution.id,
            topUpAttemptId: resolution.topUpAttemptId,
            ownerUserId,
            revision: resolution.revision,
            status: resolution.status,
          },
          data: {
            status: "intervention",
            lastError: "Refunded attempt does not prove the resolution's canonical Stripe identity",
            revision: { increment: 1 },
          },
        });
        if (held.count !== 1) {
          throw new Error("Top-up deletion refunded identity CAS lost");
        }
        continue;
      }
      if (nextStatus) {
        if (attempt.recoveryInterventionAt !== null) {
          const cleared = await prisma.topUpCheckoutAttempt.updateMany({
            where: {
              id: attempt.id,
              updatedAt: attempt.updatedAt,
              recoveryInterventionAt: attempt.recoveryInterventionAt,
            },
            data: {
              recoveryInterventionAt: null,
              recoveryAttempts: 0,
              recoveryLastError: null,
              recoveryNotBefore: null,
            },
          });
          if (cleared.count !== 1) {
            throw new Error("Top-up deletion final attempt CAS lost");
          }
        }
        const settled = await prisma.topUpCheckoutResolution.updateMany({
          where: {
            id: resolution.id,
            topUpAttemptId: resolution.topUpAttemptId,
            ownerUserId,
            revision: resolution.revision,
            status: resolution.status,
          },
          data: {
            status: nextStatus,
            lastError: null,
            revision: { increment: 1 },
          },
        });
        if (settled.count !== 1) {
          throw new Error("Top-up deletion final resolution CAS lost");
        }
      }
    } else if (attempt.stripeCheckoutSessionId !== null && resolution.status === "refund_pending") {
      // A bound Session is handled by the refund saga; do not rewrite it here.
      continue;
    }
  }
  return { count: newlyRequired.count + alreadyRequired.count };
}
