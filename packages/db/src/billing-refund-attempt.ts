import { getDb } from "./provider";
import {
  startRetryableTransaction,
  type PrismaTransaction,
} from "./transaction";

export const BILLING_REFUND_PROCESSING_STATUSES = [
  "required",
  "refund_pending",
] as const;

function isProcessingStatus(status: string): boolean {
  return BILLING_REFUND_PROCESSING_STATUSES.some((item) => item === status);
}

function assertDate(value: Date, name: string): void {
  if (Number.isNaN(value.getTime())) {
    throw new RangeError(`${name} must be a valid date`);
  }
}

export async function scheduleBillingRefundAttempt({
  disposition,
  sourceKey,
  stripeCustomerId,
  stripeCheckoutSessionId,
  stripeSubscriptionId,
  stripeInvoiceId,
  stripePaymentIntentId,
  now = new Date(),
  prisma,
}: {
  disposition: string;
  sourceKey: string;
  stripeCustomerId: string;
  stripeCheckoutSessionId: string;
  stripeSubscriptionId: string;
  stripeInvoiceId: string | null;
  stripePaymentIntentId: string | null;
  now?: Date;
  prisma?: PrismaTransaction;
}) {
  assertDate(now, "now");
  const values = [
    disposition,
    sourceKey,
    stripeCustomerId,
    stripeCheckoutSessionId,
    stripeSubscriptionId,
  ];
  if (values.some((value) => value.trim().length === 0)) {
    throw new RangeError("Billing refund identity values must not be empty");
  }

  const run = async (tx: PrismaTransaction) => {
    const attempt = await tx.billingRefundAttempt.upsert({
      where: { sourceKey },
      create: {
        disposition,
        sourceKey,
        stripeCustomerId,
        stripeCheckoutSessionId,
        stripeSubscriptionId,
        stripeInvoiceId,
        stripePaymentIntentId,
        status: "required",
        notBefore: now,
      },
      update: {},
    });
    if (
      attempt.disposition !== disposition ||
      attempt.stripeCustomerId !== stripeCustomerId ||
      attempt.stripeCheckoutSessionId !== stripeCheckoutSessionId ||
      attempt.stripeSubscriptionId !== stripeSubscriptionId ||
      attempt.stripeInvoiceId !== stripeInvoiceId ||
      attempt.stripePaymentIntentId !== stripePaymentIntentId
    ) {
      throw new Error(`Billing refund source ${sourceKey} conflicts with Stripe`);
    }
    if (isProcessingStatus(attempt.status) && attempt.interventionAt === null) {
      await tx.billingRefundAttempt.updateMany({
        where: {
          id: attempt.id,
          status: attempt.status,
          updatedAt: attempt.updatedAt,
          interventionAt: null,
        },
        data: { notBefore: now },
      });
    }
    return await tx.billingRefundAttempt.findUnique({
      where: { id: attempt.id },
    });
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

export async function findBillingRefundAttemptByPaymentIntentId({
  stripePaymentIntentId,
  prisma,
}: {
  stripePaymentIntentId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.billingRefundAttempt.findUnique({
    where: { stripePaymentIntentId },
  });
}

export async function listDueBillingRefundAttempts({
  now,
  limit = 50,
  prisma,
}: {
  now: Date;
  limit?: number;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.billingRefundAttempt.findMany({
    where: {
      status: { in: [...BILLING_REFUND_PROCESSING_STATUSES] },
      interventionAt: null,
      AND: [
        { OR: [{ notBefore: null }, { notBefore: { lte: now } }] },
        { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
      ],
    },
    orderBy: [{ notBefore: "asc" }, { createdAt: "asc" }],
    take: limit,
  });
}

export async function claimBillingRefundAttempt({
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
    throw new RangeError("Billing refund lease must expire after it starts");
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("Billing refund max attempts must be positive");
  }

  const run = async (tx: PrismaTransaction) => {
    const attempt = await tx.billingRefundAttempt.findUnique({
      where: { id: attemptId },
    });
    const due = attempt?.notBefore === null ||
      (attempt?.notBefore !== undefined &&
        attempt.notBefore.getTime() <= now.getTime());
    const leaseAvailable = attempt?.leaseExpiresAt === null ||
      (attempt?.leaseExpiresAt !== undefined &&
        attempt.leaseExpiresAt.getTime() <= now.getTime());
    if (
      !attempt ||
      !isProcessingStatus(attempt.status) ||
      attempt.interventionAt !== null ||
      !due ||
      !leaseAvailable
    ) {
      return { outcome: "not-claimed" as const };
    }
    if (attempt.attempts >= maxAttempts) {
      const escalated = await tx.billingRefundAttempt.updateMany({
        where: {
          id: attempt.id,
          status: attempt.status,
          updatedAt: attempt.updatedAt,
          interventionAt: null,
        },
        data: {
          status: "intervention_required",
          interventionAt: now,
          notBefore: null,
          leaseToken: null,
          leaseExpiresAt: null,
          lastError: attempt.lastError ??
            `Automatic billing refund processing exhausted ${maxAttempts} attempts`,
        },
      });
      return escalated.count === 1
        ? { outcome: "intervention-required" as const }
        : { outcome: "not-claimed" as const };
    }

    const claimed = await tx.billingRefundAttempt.updateMany({
      where: {
        id: attempt.id,
        status: attempt.status,
        updatedAt: attempt.updatedAt,
        interventionAt: null,
      },
      data: {
        leaseToken,
        leaseExpiresAt,
        attempts: { increment: 1 },
      },
    });
    if (claimed.count !== 1) {
      return { outcome: "not-claimed" as const };
    }
    const claimedAttempt = await tx.billingRefundAttempt.findUnique({
      where: { id: attempt.id },
    });
    if (!claimedAttempt) {
      throw new Error("Claimed billing refund disappeared");
    }
    return { outcome: "claimed" as const, attempt: claimedAttempt };
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

export async function recordBillingRefundCancellation({
  attemptId,
  leaseToken,
  now,
  prisma,
}: {
  attemptId: string;
  leaseToken?: string;
  now: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const updated = await db.billingRefundAttempt.updateMany({
    where: {
      id: attemptId,
      status: { in: [...BILLING_REFUND_PROCESSING_STATUSES] },
      ...(leaseToken === undefined ? {} : { leaseToken }),
      interventionAt: null,
    },
    data: { cancellationCompletedAt: now },
  });
  return updated.count === 1;
}

export async function attachBillingRefundId({
  attemptId,
  leaseToken,
  refundId,
  prisma,
}: {
  attemptId: string;
  leaseToken: string;
  refundId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const updated = await db.billingRefundAttempt.updateMany({
    where: {
      id: attemptId,
      status: { in: [...BILLING_REFUND_PROCESSING_STATUSES] },
      leaseToken,
      interventionAt: null,
    },
    data: { refundId },
  });
  return updated.count === 1;
}

export async function recordBillingRefundState({
  attemptId,
  stripePaymentIntentId,
  targetAmount,
  succeededAmount,
  pendingAmount,
  currency,
  refundId,
  refundStatus,
  observedAt,
  leaseToken,
  interventionReason,
  prisma,
}: {
  attemptId: string;
  stripePaymentIntentId: string;
  targetAmount: number;
  succeededAmount: number;
  pendingAmount: number;
  currency: string;
  refundId: string | null;
  refundStatus: string | null;
  observedAt: Date;
  leaseToken?: string;
  interventionReason?: string;
  prisma?: PrismaTransaction;
}) {
  if (
    !Number.isSafeInteger(targetAmount) ||
    !Number.isSafeInteger(succeededAmount) ||
    !Number.isSafeInteger(pendingAmount) ||
    targetAmount <= 0 ||
    succeededAmount < 0 ||
    pendingAmount < 0 ||
    succeededAmount + pendingAmount > targetAmount
  ) {
    throw new RangeError("Canonical billing refund amounts are invalid");
  }
  const normalizedCurrency = currency.toLowerCase();
  const run = async (tx: PrismaTransaction) => {
    for (let retry = 0; retry < 8; retry++) {
      const attempt = await tx.billingRefundAttempt.findUnique({
        where: { id: attemptId },
      });
      if (
        !attempt ||
        attempt.status === "no_refund_required" ||
        (leaseToken !== undefined && attempt.leaseToken !== leaseToken)
      ) {
        return { count: 0 };
      }
      if (
        (attempt.stripePaymentIntentId !== null &&
          attempt.stripePaymentIntentId !== stripePaymentIntentId) ||
        (attempt.targetAmount !== null && attempt.targetAmount !== targetAmount) ||
        (attempt.currency !== null && attempt.currency !== normalizedCurrency)
      ) {
        throw new Error(`Billing refund ${attempt.id} conflicts with Stripe`);
      }
      if (attempt.status === "refunded") {
        return { count: 0 };
      }
      if (succeededAmount < attempt.succeededAmount) {
        return { count: 0 };
      }

      const fullyRefunded = succeededAmount === targetAmount;
      const requiresIntervention = !fullyRefunded && interventionReason !== undefined;
      const status = fullyRefunded
        ? "refunded"
        : requiresIntervention || attempt.interventionAt !== null
          ? "intervention_required"
          : pendingAmount > 0
            ? "refund_pending"
            : "required";
      const updated = await tx.billingRefundAttempt.updateMany({
        where: {
          id: attempt.id,
          status: attempt.status,
          updatedAt: attempt.updatedAt,
          ...(leaseToken === undefined ? {} : { leaseToken }),
        },
        data: {
          stripePaymentIntentId,
          targetAmount,
          succeededAmount,
          pendingAmount,
          currency: normalizedCurrency,
          ...(refundId === null
            ? {}
            : {
                refundId,
                refundStatus,
                refundStatusObservedAt: observedAt,
              }),
          status,
          ...(fullyRefunded
            ? {
                notBefore: null,
                leaseToken: null,
                leaseExpiresAt: null,
                lastError: null,
                interventionAt: null,
              }
            : requiresIntervention
              ? {
                  notBefore: null,
                  leaseToken: null,
                  leaseExpiresAt: null,
                  lastError: interventionReason,
                  interventionAt: observedAt,
                }
              : attempt.interventionAt === null
                ? { notBefore: observedAt }
                : {}),
        },
      });
      if (updated.count === 1) {
        return updated;
      }
    }
    throw new Error("Billing refund changed concurrently");
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

export async function rescheduleBillingRefundAttempt({
  attemptId,
  leaseToken,
  notBefore,
  lastError,
  prisma,
}: {
  attemptId: string;
  leaseToken: string;
  notBefore: Date;
  lastError: string | null;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const updated = await db.billingRefundAttempt.updateMany({
    where: {
      id: attemptId,
      status: { in: [...BILLING_REFUND_PROCESSING_STATUSES] },
      leaseToken,
      interventionAt: null,
    },
    data: {
      notBefore,
      leaseToken: null,
      leaseExpiresAt: null,
      lastError,
    },
  });
  return updated.count === 1;
}

export async function markBillingRefundInterventionRequired({
  attemptId,
  leaseToken,
  now,
  reason,
  prisma,
}: {
  attemptId: string;
  leaseToken: string;
  now: Date;
  reason: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const updated = await db.billingRefundAttempt.updateMany({
    where: {
      id: attemptId,
      status: { in: [...BILLING_REFUND_PROCESSING_STATUSES] },
      leaseToken,
      interventionAt: null,
    },
    data: {
      status: "intervention_required",
      interventionAt: now,
      notBefore: null,
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: reason,
    },
  });
  return updated.count === 1;
}

export async function markBillingRefundNoRefundRequired({
  attemptId,
  leaseToken,
  now,
  prisma,
}: {
  attemptId: string;
  leaseToken: string;
  now: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const updated = await db.billingRefundAttempt.updateMany({
    where: {
      id: attemptId,
      status: "required",
      stripePaymentIntentId: null,
      leaseToken,
      interventionAt: null,
    },
    data: {
      status: "no_refund_required",
      cancellationCompletedAt: now,
      notBefore: null,
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: null,
    },
  });
  return updated.count === 1;
}
