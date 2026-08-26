import { addPurchasedCredits, type StripePaymentDetails } from "./credit-account";
import { getDb } from "./provider";
import {
  startRetryableTransaction,
  type PrismaTransaction,
} from "./transaction";

export const TOP_UP_REFUND_PROCESSING_STATUSES = [
  "refund_required",
  "refund_pending",
  "refund_failed",
] as const;

const TERMINAL_ATTEMPT_STATUSES = new Set([
  "fulfilled",
  "refunded",
]);

function isRefundProcessingStatus(status: string): boolean {
  return TOP_UP_REFUND_PROCESSING_STATUSES.some((item) => item === status);
}

export async function createTopUpCheckoutAttempt({
  ownerUserId,
  stripeCustomerId,
  billingOfferId,
  expiresAt,
  prisma,
}: {
  ownerUserId: string;
  stripeCustomerId: string;
  billingOfferId: string;
  expiresAt: Date;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    const deletionIntent = await tx.accountDeletionIntent.findFirst({
      where: { userId: ownerUserId, expiresAt: { gt: new Date() } },
      select: { userId: true },
    });
    if (deletionIntent) {
      throw new Error("Account deletion is already authorized");
    }
    return await tx.topUpCheckoutAttempt.create({
      data: {
        ownerUserId,
        stripeCustomerId,
        billingOfferId,
        status: "open",
        expiresAt,
      },
    });
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
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
    data: { stripeCheckoutSessionId, expiresAt },
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
    data: { stripeCheckoutSessionId, expiresAt },
  });
  return refund.count === 1 ? "stored-for-refund" as const : "not-stored" as const;
}

export async function setTopUpCheckoutParams({ attemptId, paramsJson, prisma }: { attemptId: string; paramsJson: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.topUpCheckoutAttempt.updateMany({ where: { id: attemptId, stripeCheckoutSessionId: null, accountDeletionAt: null }, data: { paramsJson } });
}

export async function claimDetachedTopUpCheckoutAttempts({ now, leaseToken, leaseExpiresAt, limit = 50, prisma }: { now: Date; leaseToken: string; leaseExpiresAt: Date; limit?: number; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  const rows = await db.topUpCheckoutAttempt.findMany({ where: { accountDeletionAt: { not: null }, recoveryInterventionAt: null, stripeCheckoutSessionId: null, status: { notIn: ["fulfilled", "refunded", "refund_not_required"] }, OR: [{ recoveryLeaseExpiresAt: null }, { recoveryLeaseExpiresAt: { lte: now } }], AND: [{ OR: [{ recoveryNotBefore: null }, { recoveryNotBefore: { lte: now } }] }] }, take: limit });
  const claimed = [];
  for (const row of rows) {
    const updated = await db.topUpCheckoutAttempt.updateMany({ where: { id: row.id, status: row.status, stripeCheckoutSessionId: null, recoveryLeaseToken: row.recoveryLeaseToken, OR: [{ recoveryLeaseExpiresAt: null }, { recoveryLeaseExpiresAt: { lte: now } }] }, data: { recoveryLeaseToken: leaseToken, recoveryLeaseExpiresAt: leaseExpiresAt, recoveryAttempts: { increment: 1 } } });
    if (updated.count === 1) claimed.push({ ...row, recoveryLeaseToken: leaseToken });
  }
  return claimed;
}

export async function clearDetachedTopUpCheckoutRecovery({ attemptId, leaseToken, lastError, notBefore, prisma }: { attemptId: string; leaseToken: string; lastError?: string; notBefore?: Date; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.topUpCheckoutAttempt.updateMany({ where: { id: attemptId, recoveryLeaseToken: leaseToken }, data: { recoveryLeaseToken: null, recoveryLeaseExpiresAt: null, recoveryLastError: lastError ?? null, recoveryNotBefore: lastError ? (notBefore ?? new Date()) : null } });
}

export async function completeDetachedTopUpCheckoutRecovery({ attemptId, leaseToken, stripeCheckoutSessionId, expiresAt, prisma }: { attemptId: string; leaseToken: string; stripeCheckoutSessionId: string; expiresAt: Date; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.topUpCheckoutAttempt.updateMany({ where: { id: attemptId, recoveryLeaseToken: leaseToken, stripeCheckoutSessionId: null, accountDeletionAt: { not: null } }, data: { stripeCheckoutSessionId, expiresAt, status: "refund_required", refundNotBefore: new Date(), recoveryLeaseToken: null, recoveryLeaseExpiresAt: null } });
}

export async function markDetachedTopUpCheckoutRecoveryIntervention({ attemptId, leaseToken, lastError, prisma }: { attemptId: string; leaseToken: string; lastError: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.topUpCheckoutAttempt.updateMany({ where: { id: attemptId, recoveryLeaseToken: leaseToken }, data: { recoveryInterventionAt: new Date(), recoveryLastError: lastError, recoveryLeaseToken: null, recoveryLeaseExpiresAt: null } });
}

export async function markDetachedTopUpCheckoutRecoveryTerminal({ attemptId, leaseToken, prisma }: { attemptId: string; leaseToken: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.topUpCheckoutAttempt.updateMany({ where: { id: attemptId, recoveryLeaseToken: leaseToken, stripeCheckoutSessionId: null }, data: { status: "refund_not_required", recoveryLeaseToken: null, recoveryLeaseExpiresAt: null, recoveryNotBefore: null } });
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
  now = new Date(),
  prisma,
}: {
  attemptId: string;
  stripePaymentIntentId: string;
  stripePayment: StripePaymentDetails;
  now?: Date;
  prisma?: PrismaTransaction;
}): Promise<
  | { status: "fulfilled" | "already-fulfilled"; userId: string; creditAmount: number }
  | { status: "refund-required" }
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
      attempt.stripePaymentIntentId !== null &&
      attempt.stripePaymentIntentId !== stripePaymentIntentId
    ) {
      return { status: "invalid" as const };
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
      attempt.status === "refund_not_required"
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
      },
      data: {
        stripePaymentIntentId,
        status: "fulfilled",
        fulfilledAt: now,
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
      TERMINAL_ATTEMPT_STATUSES.has(attempt.status) ||
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
        ...(attempt.status === "refund_not_required"
          ? {
              refundStatus: null,
              refundStatusObservedAt: null,
              refundTargetAmount: null,
              refundSucceededAmount: 0,
              refundPendingAmount: 0,
              refundCurrency: null,
              refundAttempts: 0,
              refundLastError: null,
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
        attempt.status === "refund_not_required" ||
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
        : attempt.refundInterventionAt !== null
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
          refundTargetAmount,
          refundSucceededAmount,
          refundPendingAmount,
          refundCurrency: normalizedCurrency,
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
                refundNotBefore: null,
                refundLeaseToken: null,
                refundLeaseExpiresAt: null,
                refundLastError: null,
                refundInterventionAt: null,
              }
            : attempt.refundInterventionAt === null
              ? { refundNotBefore: now }
              : {}),
        },
      });
      if (updated.count === 1) {
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
  return { count: newlyRequired.count + alreadyRequired.count };
}
