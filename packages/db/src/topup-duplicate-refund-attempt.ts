import { getDb } from "./provider";
import {
  startRetryableTransaction,
  type PrismaTransaction,
} from "./transaction";

const CLAIMABLE_STATUSES = [
  "required",
  "retry",
  "processing",
  "intervention",
] as const;

type ResolutionOperatorState = {
  operatorLeaseToken: string | null;
  operatorLeaseExpiresAt: Date | null;
  operatorAbsenceObservedAt: Date | null;
};

export async function scheduleTopUpDuplicateRefundAttempt({
  topUpAttemptId,
  stripePaymentIntentId,
  stripeCustomerId,
  ownerUserId,
  billingOfferId,
  amount,
  currency,
  prisma,
}: {
  topUpAttemptId: string;
  stripePaymentIntentId: string;
  stripeCustomerId: string;
  ownerUserId: string;
  billingOfferId: string;
  amount: number;
  currency: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const existing = await db.topUpDuplicateRefundAttempt.findUnique({
    where: { stripePaymentIntentId },
  });
  if (existing) {
    if (
      existing.topUpAttemptId !== topUpAttemptId ||
      existing.stripeCustomerId !== stripeCustomerId ||
      existing.ownerUserId !== ownerUserId ||
      existing.billingOfferId !== billingOfferId ||
      existing.amount !== amount ||
      existing.currency.toLowerCase() !== currency.toLowerCase()
    ) {
      throw new Error("Top-up duplicate refund identity conflict");
    }
    return existing;
  }
  return await db.topUpDuplicateRefundAttempt.create({
    data: {
      topUpAttemptId,
      stripePaymentIntentId,
      stripeCustomerId,
      ownerUserId,
      billingOfferId,
      amount,
      currency: currency.toLowerCase(),
      status: "required",
    },
  });
}

export type ClaimedTopUpDuplicateRefund = Awaited<
  ReturnType<typeof scheduleTopUpDuplicateRefundAttempt>
> & {
  claimKind: "automatic" | "canonical-recheck";
};

export async function claimTopUpDuplicateRefundAttempts({
  now,
  leaseToken,
  leaseExpiresAt,
  limit = 50,
  prisma,
}: {
  now: Date;
  leaseToken: string;
  leaseExpiresAt: Date;
  limit?: number;
  prisma?: PrismaTransaction;
}): Promise<ClaimedTopUpDuplicateRefund[]> {
  const db = prisma ?? await getDb();
  const rows = await db.topUpDuplicateRefundAttempt.findMany({
    where: {
      status: { in: [...CLAIMABLE_STATUSES] },
      notBefore: { lte: now },
      OR: [
        { leaseExpiresAt: null },
        { leaseExpiresAt: { lte: now } },
      ],
    },
    orderBy: [{ notBefore: "asc" }, { createdAt: "asc" }],
    take: limit,
  });
  const claimed: ClaimedTopUpDuplicateRefund[] = [];
  for (const row of rows) {
    const claimKind = row.status === "intervention" || row.interventionAt !== null
      ? "canonical-recheck" as const
      : "automatic" as const;
    const nextAttempts = claimKind === "automatic"
      ? row.attempts + 1
      : row.attempts;
    const updated = await db.topUpDuplicateRefundAttempt.updateMany({
      where: {
        id: row.id,
        status: row.status,
        leaseToken: row.leaseToken,
        updatedAt: row.updatedAt,
        OR: [
          { leaseExpiresAt: null },
          { leaseExpiresAt: { lte: now } },
        ],
      },
      data: {
        status: "processing",
        leaseToken,
        leaseExpiresAt,
        ...(claimKind === "automatic"
          ? { attempts: { increment: 1 } }
          : {}),
      },
    });
    if (updated.count === 1) {
      claimed.push({
        ...row,
        status: "processing",
        leaseToken,
        leaseExpiresAt,
        attempts: nextAttempts,
        claimKind,
      });
    }
  }
  return claimed;
}

export async function completeTopUpDuplicateRefundAttempt({
  id,
  leaseToken,
  refundId,
  refundedAmount,
  observedAt,
  prisma,
}: {
  id: string;
  leaseToken: string;
  refundId: string;
  refundedAmount: number;
  observedAt: Date;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    const updated = await tx.topUpDuplicateRefundAttempt.updateMany({
      where: { id, status: "processing", leaseToken, amount: refundedAmount },
      data: {
        status: "refunded",
        refundId,
        refundedAmount,
        leaseToken: null,
        leaseExpiresAt: null,
        notBefore: observedAt,
        lastError: null,
        lastCanonicalCheckAt: observedAt,
      },
    });
    if (updated.count !== 1) return updated;

    const completed = await tx.topUpDuplicateRefundAttempt.findUnique({
      where: { id },
    });
    if (!completed) {
      throw new Error("Completed top-up duplicate refund disappeared");
    }
    const resolution = await tx.topUpCheckoutResolution.findUnique({
      where: { topUpAttemptId: completed.topUpAttemptId },
    }) as (NonNullable<Awaited<ReturnType<typeof tx.topUpCheckoutResolution.findUnique>>> & ResolutionOperatorState) | null;
    if (resolution?.status !== "intervention") return updated;
    if (resolution.operatorLeaseToken && resolution.operatorLeaseExpiresAt && resolution.operatorLeaseExpiresAt > observedAt) return updated;
    const expectedIds = JSON.parse(
      resolution.expectedPaymentIntentIds,
    ) as string[];
    const refunds = await tx.topUpDuplicateRefundAttempt.findMany({
      where: { stripePaymentIntentId: { in: expectedIds } },
      select: { stripePaymentIntentId: true, status: true, amount: true, refundedAmount: true },
    });
    if (!expectedIds.every((paymentIntentId) => refunds.some((item) =>
      item.stripePaymentIntentId === paymentIntentId &&
      item.status === "refunded" && item.refundedAmount === item.amount))) {
      return updated;
    }
    const attempt = await tx.topUpCheckoutAttempt.findUnique({
      where: { id: completed.topUpAttemptId },
    });
    if (!attempt) {
      await tx.topUpCheckoutResolution.updateMany({
        where: {
          id: resolution.id,
          revision: resolution.revision,
          status: "intervention",
        },
        data: ({
          lastError: "Refund settled but the top-up attempt is missing",
          operatorLeaseToken: null,
          operatorLeaseExpiresAt: null,
          operatorAbsenceObservedAt: null,
          revision: { increment: 1 },
        } as never),
      });
      return updated;
    }

    const terminalStatuses = new Set([
      "fulfilled",
      "expired",
      "refunded",
      "refund_not_required",
    ]);
    let resolutionStatus = attempt.stripeCheckoutSessionId !== null
      ? "resolved"
      : terminalStatuses.has(attempt.status) ? "terminal" : "refund_pending";
    if (
      resolutionStatus === "refund_pending" &&
      attempt.recoveryInterventionAt !== null
    ) {
      const resumedAttempt = await tx.topUpCheckoutAttempt.updateMany({
        where: {
          id: attempt.id,
          updatedAt: attempt.updatedAt,
          stripeCheckoutSessionId: null,
          recoveryInterventionAt: attempt.recoveryInterventionAt,
        },
        data: {
          recoveryInterventionAt: null,
          recoveryAttempts: 0,
          recoveryLastError: null,
          recoveryNotBefore: observedAt,
        },
      });
      if (resumedAttempt.count !== 1) {
        const current = await tx.topUpCheckoutAttempt.findUnique({
          where: { id: attempt.id },
        });
        if (!current) {
          resolutionStatus = "terminal";
        } else if (current.stripeCheckoutSessionId !== null) {
          resolutionStatus = "resolved";
        } else if (terminalStatuses.has(current.status)) {
          resolutionStatus = "terminal";
        } else if (current.recoveryInterventionAt !== null) {
          await tx.topUpCheckoutResolution.updateMany({
            where: {
              id: resolution.id,
              revision: resolution.revision,
              status: "intervention",
            },
            data: ({
              lastError: "Refund settled but recovery ownership changed",
              operatorLeaseToken: null,
              operatorLeaseExpiresAt: null,
              operatorAbsenceObservedAt: null,
              revision: { increment: 1 },
            } as never),
          });
          return updated;
        }
      }
    }

    const resumed = await tx.topUpCheckoutResolution.updateMany({
      where: {
        id: resolution.id,
        revision: resolution.revision,
        status: "intervention",
      },
      data: ({
        status: resolutionStatus,
        lastError: null,
        operatorLeaseToken: null,
        operatorLeaseExpiresAt: null,
        operatorAbsenceObservedAt: null,
        revision: { increment: 1 },
      } as never),
    });
    if (resumed.count !== 1) {
      const current = await tx.topUpCheckoutResolution.findUnique({
        where: { topUpAttemptId: completed.topUpAttemptId },
      });
      if (current?.status === "intervention") {
        throw new Error("Top-up resolution recovery CAS lost");
      }
    }
    return updated;
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

export async function rescheduleTopUpDuplicateRefundAttempt({
  id,
  leaseToken,
  notBefore,
  lastError,
  observedAt,
  prisma,
}: {
  id: string;
  leaseToken: string;
  notBefore: Date;
  lastError: string;
  observedAt: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.topUpDuplicateRefundAttempt.updateMany({
    where: { id, status: "processing", leaseToken },
    data: {
      status: "retry",
      notBefore,
      lastError,
      lastCanonicalCheckAt: observedAt,
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
}

export async function markTopUpDuplicateRefundIntervention({
  id,
  leaseToken,
  interventionAt,
  nextCanonicalCheckAt,
  lastError,
  observedAt,
  prisma,
}: {
  id: string;
  leaseToken: string;
  interventionAt: Date;
  nextCanonicalCheckAt: Date;
  lastError: string;
  observedAt: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.topUpDuplicateRefundAttempt.updateMany({
    where: { id, status: "processing", leaseToken },
    data: {
      status: "intervention",
      interventionAt,
      notBefore: nextCanonicalCheckAt,
      lastError,
      lastCanonicalCheckAt: observedAt,
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
}
