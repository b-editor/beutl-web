import { getDb } from "./provider";
import { normalizeUsageUnits } from "@beutl/core";
import {
  decimalNumberRows,
  decimalNumbers,
} from "./decimal";
import {
  startRetryableTransaction,
  type PrismaTransaction,
} from "./transaction";

export class AiUsageLimitExceededError extends Error {
  constructor() {
    super("The monthly AI usage allowance and purchased credits are insufficient");
    this.name = "AiUsageLimitExceededError";
  }
}

// An administrator adjustment must never silently do less than it says. It is
// rejected outright when the account cannot absorb it.
export class CreditAdjustmentRejectedError extends Error {
  constructor(
    readonly reason:
      | "insufficientCredits"
      | "usageOutOfRange"
      | "conflictingAdjustment"
      | "staleUsage",
    message: string,
  ) {
    super(message);
    this.name = "CreditAdjustmentRejectedError";
  }
}

export type UsagePeriod = {
  start: Date | null;
  end: Date | null;
};

export type StripeCreditReversalKind = "refund" | "dispute";

export type StripePaymentDetails = {
  amount: number;
  currency: string;
};

type StripeCreditReversalInput = {
  stripePaymentId: string;
  stripePayment: StripePaymentDetails;
  reversalKind: StripeCreditReversalKind;
  reversalId: string;
  reversalAmount: number;
  reversalCurrency: string;
  status: string;
  active: boolean;
  stripeEventId: string;
  stripeEventCreatedAt: Date;
};

const PURCHASE_REVERSAL_TRANSACTION_KIND = "purchase_reversal";
export const ADMIN_CREDIT_ADJUSTMENT_KIND = "admin_credit_adjustment";
export const ADMIN_USAGE_ADJUSTMENT_KIND = "admin_usage_adjustment";
export const AI_USAGE_SETTLEMENT_KIND = "usage_settlement";
const MAX_REVERSAL_CAS_ATTEMPTS = 8;

const TERMINAL_REFUND_STATUSES = new Set([
  "succeeded",
  "failed",
  "canceled",
]);
const TERMINAL_DISPUTE_STATUSES = new Set([
  "lost",
  "won",
  "prevented",
  "warning_closed",
]);

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}

function normalizeUsageAmount(
  value: number,
  name: string,
  allowZero: boolean,
): number {
  const normalized = normalizeUsageUnits(value);
  if (
    normalized === null ||
    (allowZero ? normalized < 0 : normalized <= 0)
  ) {
    throw new RangeError(
      `${name} must be ${allowZero ? "non-negative" : "positive"} and within the supported usage-unit range`,
    );
  }
  return normalized;
}

function exactUsageAmount(value: number, name: string): number {
  const normalized = normalizeUsageUnits(value);
  if (normalized === null) {
    throw new RangeError(`${name} is outside the supported usage-unit range`);
  }
  return normalized;
}

function assertNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new RangeError(`${name} must not be empty`);
  }
}

function assertValidDate(value: Date, name: string): void {
  if (Number.isNaN(value.getTime())) {
    throw new RangeError(`${name} must be a valid date`);
  }
}

function reversalProgressionRank(
  reversalKind: StripeCreditReversalKind,
  status: string,
): number {
  const terminalStatuses =
    reversalKind === "refund"
      ? TERMINAL_REFUND_STATUSES
      : TERMINAL_DISPUTE_STATUSES;
  return terminalStatuses.has(status) ? 100 : 10;
}

function compareReversalObservation(
  incoming: {
    progressionRank: number;
    stripeEventCreatedAt: Date;
    stripeEventId: string;
  },
  stored: {
    progressionRank: number;
    stripeEventCreatedAt: Date | null;
    stripeEventId: string | null;
  },
): number {
  // Reversal lifecycle progression is irreversible. A pending observation can
  // never reactivate after a terminal refund/dispute state, even if it stalled
  // long enough to carry a later delivery watermark.
  if (incoming.progressionRank !== stored.progressionRank) {
    return incoming.progressionRank - stored.progressionRank;
  }
  if (stored.stripeEventCreatedAt === null) {
    return 1;
  }
  const createdDifference =
    incoming.stripeEventCreatedAt.getTime() -
    stored.stripeEventCreatedAt.getTime();
  if (createdDifference !== 0) {
    return createdDifference;
  }
  const storedEventId = stored.stripeEventId ?? "";
  if (incoming.stripeEventId === storedEventId) {
    return 0;
  }
  return incoming.stripeEventId > storedEventId ? 1 : -1;
}

function normalizeCurrency(currency: string): string {
  assertNonEmpty(currency, "currency");
  return currency.toLowerCase();
}

function assertStripePaymentDetails(
  details: StripePaymentDetails,
  name: string,
): void {
  assertPositiveInteger(details.amount, `${name}.amount`);
  normalizeCurrency(details.currency);
}

function datesEqual(left: Date | null, right: Date | null): boolean {
  return left?.getTime() === right?.getTime();
}

// Exported so a caller that supplies its own transaction — where a rejected
// insert has already aborted everything and nothing can be read back here —
// can still recognize that the write it lost was applied by the winner.
export function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

// Exported because a reader that shows a stored counter has to decide whether
// it still belongs to the current cycle, and answering that differently from
// the writer is how a previous period's consumption gets written back.
export function usagePeriodsEqual(
  left: UsagePeriod,
  right: UsagePeriod,
): boolean {
  // The period start identifies a billing cycle while its end can be adjusted
  // in-place by Stripe. Fall back to the end for legacy rows whose start was
  // not recorded yet.
  if (left.start && right.start) {
    return datesEqual(left.start, right.start);
  }
  if (left.end || right.end) {
    return datesEqual(left.end, right.end);
  }
  return datesEqual(left.start, right.start);
}

async function getAccountForUsagePeriod({
  userId,
  usagePeriod,
  prisma,
}: {
  userId: string;
  usagePeriod: UsagePeriod;
  prisma: PrismaTransaction;
}) {
  const account = decimalNumbers(await prisma.creditAccount.upsert({
    where: {
      userId,
    },
    create: {
      userId,
      usagePeriodStart: usagePeriod.start,
      usagePeriodEnd: usagePeriod.end,
    },
    update: {},
  }));

  const storedPeriod = {
    start: account.usagePeriodStart,
    end: account.usagePeriodEnd,
  };
  if (!usagePeriodsEqual(storedPeriod, usagePeriod)) {
    return decimalNumbers(await prisma.creditAccount.update({
      where: {
        userId,
      },
      data: {
        monthlyUsageUsed: 0,
        usagePeriodStart: usagePeriod.start,
        usagePeriodEnd: usagePeriod.end,
      },
    }));
  }

  // Refresh period metadata without resetting usage when Stripe only adjusted
  // the end or a newly available start was backfilled.
  if (
    !datesEqual(account.usagePeriodStart, usagePeriod.start) ||
    !datesEqual(account.usagePeriodEnd, usagePeriod.end)
  ) {
    return decimalNumbers(await prisma.creditAccount.update({
      where: {
        userId,
      },
      data: {
        usagePeriodStart: usagePeriod.start,
        usagePeriodEnd: usagePeriod.end,
      },
    }));
  }

  return account;
}

export async function getCreditAccount({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return decimalNumbers(await db.creditAccount.upsert({
    where: {
      userId,
    },
    create: {
      userId,
    },
    update: {},
  }));
}

export async function getMonthlyUsageAccount({
  userId,
  usagePeriod,
  prisma,
}: {
  userId: string;
  usagePeriod: UsagePeriod;
  prisma?: PrismaTransaction;
}) {
  if (prisma) {
    return await getAccountForUsagePeriod({ userId, usagePeriod, prisma });
  }
  return await startRetryableTransaction((tx) =>
    getAccountForUsagePeriod({ userId, usagePeriod, prisma: tx }),
  );
}

async function attachStripePaymentDetails({
  stripePaymentId,
  stripePayment,
  prisma,
}: {
  stripePaymentId: string;
  stripePayment: StripePaymentDetails;
  prisma: PrismaTransaction;
}) {
  assertStripePaymentDetails(stripePayment, "stripePayment");
  const currency = normalizeCurrency(stripePayment.currency);
  const storedPurchase = await prisma.creditTransaction.findUnique({
    where: {
      stripePaymentId,
    },
  });
  if (!storedPurchase) {
    return null;
  }
  const purchase = decimalNumbers(storedPurchase);
  if (purchase.kind !== "purchase") {
    throw new Error(
      `Stripe payment ${stripePaymentId} is not linked to a credit purchase`,
    );
  }
  if (
    (purchase.stripePaymentAmount !== null &&
      purchase.stripePaymentAmount !== stripePayment.amount) ||
    (purchase.stripeCurrency !== null && purchase.stripeCurrency !== currency)
  ) {
    throw new Error(
      `Stripe payment ${stripePaymentId} conflicts with its recorded payment details`,
    );
  }
  if (
    purchase.stripePaymentAmount === null ||
    purchase.stripeCurrency === null ||
    purchase.stripeSourcePaymentId === null
  ) {
    return decimalNumbers(await prisma.creditTransaction.update({
      where: {
        id: purchase.id,
      },
      data: {
        stripePaymentAmount: stripePayment.amount,
        stripeCurrency: currency,
        stripeSourcePaymentId: stripePaymentId,
      },
    }));
  }
  return purchase;
}

async function applyPurchaseReversalTarget({
  stripePaymentId,
  reversalKind,
  reversalId,
  reversalRevision,
  prisma,
}: {
  stripePaymentId: string;
  reversalKind: StripeCreditReversalKind;
  reversalId: string;
  reversalRevision: number;
  prisma: PrismaTransaction;
}) {
  const storedProcessed = await prisma.creditTransaction.findUnique({
    where: {
      stripeReversalKind_stripeReversalId_stripeReversalRevision: {
        stripeReversalKind: reversalKind,
        stripeReversalId: reversalId,
        stripeReversalRevision: reversalRevision,
      },
    },
  });
  if (storedProcessed) {
    const processed = decimalNumbers(storedProcessed);
    return await getCreditAccount({ userId: processed.userId, prisma });
  }

  const storedPurchase = await prisma.creditTransaction.findUnique({
    where: {
      stripePaymentId,
    },
  });
  if (!storedPurchase) {
    return null;
  }
  const purchase = decimalNumbers(storedPurchase);
  if (
    purchase.kind !== "purchase" ||
    purchase.creditAmount <= 0 ||
    purchase.stripePaymentAmount === null ||
    purchase.stripePaymentAmount <= 0 ||
    purchase.stripeCurrency === null
  ) {
    throw new Error(
      `Stripe payment ${stripePaymentId} is missing valid credit purchase details`,
    );
  }

  const reversals = await prisma.stripeCreditReversal.findMany({
    where: {
      stripePaymentId,
    },
  });
  const activeStripeAmount = reversals.reduce((total, reversal) => {
    if (!reversal.active) {
      return total;
    }
    if (reversal.stripeCurrency !== purchase.stripeCurrency) {
      throw new Error(
        `Stripe reversal ${reversal.stripeReversalId} has a mismatched currency`,
      );
    }
    return total + reversal.stripeAmount;
  }, 0);
  const cappedStripeAmount = Math.min(
    activeStripeAmount,
    purchase.stripePaymentAmount,
  );
  const targetReversedCredits = Math.min(
    purchase.creditAmount,
    Math.ceil(
      (cappedStripeAmount * purchase.creditAmount) /
        purchase.stripePaymentAmount,
    ),
  );

  const adjustments = decimalNumberRows(await prisma.creditTransaction.findMany({
    where: {
      stripeSourcePaymentId: stripePaymentId,
      kind: PURCHASE_REVERSAL_TRANSACTION_KIND,
    },
  }));
  const currentReversedCredits = -adjustments.reduce(
    (total, adjustment) => total + adjustment.creditAmount,
    0,
  );
  if (
    currentReversedCredits < 0 ||
    currentReversedCredits > purchase.creditAmount
  ) {
    throw new Error(
      `Stripe payment ${stripePaymentId} has an invalid reversal ledger balance`,
    );
  }

  const account = await getCreditAccount({ userId: purchase.userId, prisma });
  const reversalDelta = targetReversedCredits - currentReversedCredits;
  let updated = account;
  let creditAmount = 0;
  let debtAmount = 0;

  if (reversalDelta > 0) {
    const creditsConsumed = Math.min(
      account.purchasedCredits,
      reversalDelta,
    );
    const debtAdded = reversalDelta - creditsConsumed;
    creditAmount = -reversalDelta;
    debtAmount = debtAdded;
    updated = decimalNumbers(await prisma.creditAccount.update({
      where: {
        userId: purchase.userId,
      },
      data: {
        purchasedCredits: account.purchasedCredits - creditsConsumed,
        purchasedCreditDebt: account.purchasedCreditDebt + debtAdded,
      },
    }));
  } else if (reversalDelta < 0) {
    const restoredAmount = -reversalDelta;
    const debtPaid = Math.min(account.purchasedCreditDebt, restoredAmount);
    const creditsRestored = restoredAmount - debtPaid;
    creditAmount = restoredAmount;
    debtAmount = debtPaid === 0 ? 0 : -debtPaid;
    updated = decimalNumbers(await prisma.creditAccount.update({
      where: {
        userId: purchase.userId,
      },
      data: {
        purchasedCredits: account.purchasedCredits + creditsRestored,
        purchasedCreditDebt: account.purchasedCreditDebt - debtPaid,
      },
    }));
  }

  await prisma.creditTransaction.create({
    data: {
      userId: purchase.userId,
      creditAmount,
      debtAmount,
      kind: PURCHASE_REVERSAL_TRANSACTION_KIND,
      stripeCurrency: purchase.stripeCurrency,
      stripeSourcePaymentId: stripePaymentId,
      stripeReversalKind: reversalKind,
      stripeReversalId: reversalId,
      stripeReversalRevision: reversalRevision,
    },
  });

  return updated;
}

async function applyPendingPurchaseReversals({
  stripePaymentId,
  prisma,
}: {
  stripePaymentId: string;
  prisma: PrismaTransaction;
}) {
  const reversals = await prisma.stripeCreditReversal.findMany({
    where: {
      stripePaymentId,
    },
  });
  reversals.sort((left, right) => Number(right.active) - Number(left.active));

  let account = null;
  for (const reversal of reversals) {
    account = await applyPurchaseReversalTarget({
      stripePaymentId,
      reversalKind: reversal.stripeReversalKind as StripeCreditReversalKind,
      reversalId: reversal.stripeReversalId,
      reversalRevision: reversal.revision,
      prisma,
    });
  }
  return account;
}

// Purchased credits are persistent and are the only balance topped up by a
// one-time payment. New value settles outstanding purchased-credit debt before
// becoming spendable. Stripe payment IDs make grants idempotent transactionally.
export async function addPurchasedCredits({
  userId,
  amount,
  stripePaymentId,
  stripePayment,
  billingOfferId,
  topUpCheckoutAttemptId,
  prisma,
}: {
  userId: string;
  amount: number;
  stripePaymentId: string;
  stripePayment?: StripePaymentDetails;
  billingOfferId?: string;
  topUpCheckoutAttemptId?: string;
  prisma?: PrismaTransaction;
}) {
  assertPositiveInteger(amount, "amount");
  assertNonEmpty(stripePaymentId, "stripePaymentId");
  if (stripePayment) {
    assertStripePaymentDetails(stripePayment, "stripePayment");
  }
  const run = async (tx: PrismaTransaction) => {
    const account = await getCreditAccount({ userId, prisma: tx });
    const storedExisting = await tx.creditTransaction.findUnique({
      where: {
        stripePaymentId,
      },
    });
    if (storedExisting) {
      const existing = decimalNumbers(storedExisting);
      if (
        existing.userId !== userId ||
        existing.kind !== "purchase" ||
        existing.creditAmount !== amount ||
        (billingOfferId !== undefined &&
          existing.billingOfferId !== billingOfferId) ||
        (topUpCheckoutAttemptId !== undefined &&
          existing.topUpCheckoutAttemptId !== topUpCheckoutAttemptId)
      ) {
        throw new Error(
          `Stripe payment ${stripePaymentId} conflicts with an existing transaction`,
        );
      }
      if (stripePayment) {
        await attachStripePaymentDetails({
          stripePaymentId,
          stripePayment,
          prisma: tx,
        });
      }
      return (
        await applyPendingPurchaseReversals({
          stripePaymentId,
          prisma: tx,
        })
      ) ?? account;
    }

    const debtPaid = Math.min(account.purchasedCreditDebt, amount);
    const creditsAdded = amount - debtPaid;
    const updated = decimalNumbers(await tx.creditAccount.update({
      where: {
        userId,
      },
      data: {
        purchasedCredits: account.purchasedCredits + creditsAdded,
        purchasedCreditDebt: account.purchasedCreditDebt - debtPaid,
      },
    }));

    await tx.creditTransaction.create({
      data: {
        userId,
        creditAmount: amount,
        debtAmount: debtPaid === 0 ? 0 : -debtPaid,
        kind: "purchase",
        stripePaymentId,
        stripePaymentAmount: stripePayment?.amount,
        stripeCurrency: stripePayment
          ? normalizeCurrency(stripePayment.currency)
          : undefined,
        stripeSourcePaymentId: stripePaymentId,
        billingOfferId,
        topUpCheckoutAttemptId,
      },
    });

    return (
      await applyPendingPurchaseReversals({
        stripePaymentId,
        prisma: tx,
      })
    ) ?? updated;
  };

  if (prisma) {
    return await run(prisma);
  }
  return await startRetryableTransaction(run);
}

// Reconcile one canonical Stripe refund or dispute state. The account is
// adjusted to the aggregate active reversal amount for the source payment, so
// partial and overlapping reversals are capped at the original purchase. The
// state is retained even if it arrives before payment_intent.succeeded.
export async function reconcilePurchasedCreditReversal({
  stripePaymentId,
  stripePayment,
  reversalKind,
  reversalId,
  reversalAmount,
  reversalCurrency,
  status,
  active,
  stripeEventId,
  stripeEventCreatedAt,
  prisma,
}: StripeCreditReversalInput & { prisma?: PrismaTransaction }) {
  assertNonEmpty(stripePaymentId, "stripePaymentId");
  assertStripePaymentDetails(stripePayment, "stripePayment");
  assertNonEmpty(reversalId, "reversalId");
  assertPositiveInteger(reversalAmount, "reversalAmount");
  assertNonEmpty(status, "status");
  assertNonEmpty(stripeEventId, "stripeEventId");
  assertValidDate(stripeEventCreatedAt, "stripeEventCreatedAt");
  const paymentCurrency = normalizeCurrency(stripePayment.currency);
  const normalizedReversalCurrency = normalizeCurrency(reversalCurrency);
  const progressionRank = reversalProgressionRank(reversalKind, status);
  if (paymentCurrency !== normalizedReversalCurrency) {
    throw new Error(
      `Stripe ${reversalKind} ${reversalId} currency does not match its payment`,
    );
  }

  const run = async (tx: PrismaTransaction) => {
    const existing = await tx.stripeCreditReversal.upsert({
      where: {
        stripeReversalKind_stripeReversalId: {
          stripeReversalKind: reversalKind,
          stripeReversalId: reversalId,
        },
      },
      create: {
        stripePaymentId,
        stripeReversalKind: reversalKind,
        stripeReversalId: reversalId,
        stripeAmount: reversalAmount,
        stripeCurrency: normalizedReversalCurrency,
        status,
        active,
        progressionRank,
        stripeEventId,
        stripeEventCreatedAt,
      },
      update: {},
    });
    if (existing.stripePaymentId !== stripePaymentId) {
      throw new Error(
        `Stripe ${reversalKind} ${reversalId} conflicts with its recorded payment`,
      );
    }

    const comparison = compareReversalObservation(
      { progressionRank, stripeEventCreatedAt, stripeEventId },
      existing,
    );
    let reversal = existing;
    if (comparison > 0) {
      const stateChanged =
        existing.stripeAmount !== reversalAmount ||
        existing.stripeCurrency !== normalizedReversalCurrency ||
        existing.status !== status ||
        existing.active !== active;
      const updated = await tx.stripeCreditReversal.updateMany({
        where: {
          id: existing.id,
          revision: existing.revision,
          progressionRank: existing.progressionRank,
          stripeEventId: existing.stripeEventId,
          stripeEventCreatedAt: existing.stripeEventCreatedAt,
        },
        data: {
          stripeAmount: reversalAmount,
          stripeCurrency: normalizedReversalCurrency,
          status,
          active,
          progressionRank,
          stripeEventId,
          stripeEventCreatedAt,
          revision: stateChanged ? existing.revision + 1 : existing.revision,
        },
      });
      if (updated.count !== 1) {
        return { retry: true as const, account: null };
      }
      reversal = (await tx.stripeCreditReversal.findUnique({
        where: {
          stripeReversalKind_stripeReversalId: {
            stripeReversalKind: reversalKind,
            stripeReversalId: reversalId,
          },
        },
      }))!;
    }

    const purchase = await attachStripePaymentDetails({
      stripePaymentId,
      stripePayment: {
        amount: stripePayment.amount,
        currency: paymentCurrency,
      },
      prisma: tx,
    });
    if (!purchase) {
      return { retry: false as const, account: null };
    }

    return {
      retry: false as const,
      account: await applyPurchaseReversalTarget({
        stripePaymentId,
        reversalKind,
        reversalId,
        reversalRevision: reversal.revision,
        prisma: tx,
      }),
    };
  };

  if (prisma) {
    for (let attempt = 0; attempt < MAX_REVERSAL_CAS_ATTEMPTS; attempt++) {
      const result = await run(prisma);
      if (!result.retry) {
        return result.account;
      }
    }
  } else {
    for (let attempt = 0; attempt < MAX_REVERSAL_CAS_ATTEMPTS; attempt++) {
      const result = await startRetryableTransaction(run);
      if (!result.retry) {
        return result.account;
      }
    }
  }
  throw new Error("Could not reconcile the Stripe reversal observation");
}

// Consume the non-rollover monthly allowance first, then persistent purchased
// credits. The split is recorded so provider failures can restore each source.
export async function consumeUsage({
  userId,
  amount,
  monthlyUsageLimit,
  usagePeriod,
  aiJobId,
  prisma,
}: {
  userId: string;
  amount: number;
  monthlyUsageLimit: number;
  usagePeriod: UsagePeriod;
  aiJobId: string;
  prisma?: PrismaTransaction;
}) {
  const chargeAmount = normalizeUsageAmount(amount, "amount", false);
  assertNonNegativeInteger(monthlyUsageLimit, "monthlyUsageLimit");

  const run = async (tx: PrismaTransaction) => {
    const account = await getAccountForUsagePeriod({
      userId,
      usagePeriod,
      prisma: tx,
    });
    const storedExistingUsage = await tx.creditTransaction.findFirst({
      where: {
        userId,
        aiJobId,
        kind: "usage",
      },
    });
    if (storedExistingUsage) {
      const existingUsage = decimalNumbers(storedExistingUsage);
      const existingAmount =
        exactUsageAmount(
          existingUsage.usageAmount - existingUsage.creditAmount,
          "existingAmount",
        );
      if (existingAmount !== chargeAmount) {
        throw new Error(
          `AI job ${aiJobId} already has a different usage charge`,
        );
      }
      return account;
    }

    const monthlyRemaining = exactUsageAmount(
      Math.max(monthlyUsageLimit - account.monthlyUsageUsed, 0),
      "monthlyRemaining",
    );
    const monthlyUsed = Math.min(monthlyRemaining, chargeAmount);
    const purchasedUsed = exactUsageAmount(
      chargeAmount - monthlyUsed,
      "purchasedUsed",
    );
    if (account.purchasedCredits < purchasedUsed) {
      throw new AiUsageLimitExceededError();
    }

    const updated = decimalNumbers(await tx.creditAccount.update({
      where: {
        userId,
      },
      data: {
        monthlyUsageUsed: exactUsageAmount(
          account.monthlyUsageUsed + monthlyUsed,
          "monthlyUsageUsed",
        ),
        purchasedCredits: exactUsageAmount(
          account.purchasedCredits - purchasedUsed,
          "purchasedCredits",
        ),
      },
    }));

    await tx.creditTransaction.create({
      data: {
        userId,
        creditAmount: purchasedUsed === 0 ? 0 : -purchasedUsed,
        usageAmount: monthlyUsed,
        usagePeriodStart: usagePeriod.start,
        usagePeriodEnd: usagePeriod.end,
        kind: "usage",
        aiJobId,
      },
    });

    return updated;
  };

  if (prisma) {
    return await run(prisma);
  }
  return await startRetryableTransaction(run);
}

// Replace a conservative reservation with the provider's actual charge. The
// delta is append-only in the ledger; AiJob keeps both reservedUsageUnits and
// the settled usageUnits so the decision remains auditable.
export async function settleUsage({
  userId,
  aiJobId,
  actualAmount,
  providerCostUsdMicros,
  monthlyUsageLimit,
  currentUsagePeriod,
  prisma,
}: {
  userId: string;
  aiJobId: string;
  actualAmount: number;
  providerCostUsdMicros: number | null;
  monthlyUsageLimit: number;
  currentUsagePeriod: UsagePeriod;
  prisma?: PrismaTransaction;
}) {
  const settledAmount = normalizeUsageAmount(
    actualAmount,
    "actualAmount",
    true,
  );
  assertNonNegativeInteger(monthlyUsageLimit, "monthlyUsageLimit");
  if (
    providerCostUsdMicros !== null &&
    (!Number.isSafeInteger(providerCostUsdMicros) ||
      providerCostUsdMicros < 0)
  ) {
    throw new RangeError("providerCostUsdMicros must be null or non-negative");
  }

  const run = async (tx: PrismaTransaction) => {
    const job = await tx.aiJob.findFirst({
      where: { id: aiJobId, userId, deletedAt: null },
    });
    if (!job) throw new Error(`AI job ${aiJobId} was not found for user ${userId}`);
    if (job.status !== "succeeded") {
      throw new Error(`AI job ${aiJobId} must succeed before usage is settled`);
    }
    if (job.usageSettledAt !== null) {
      return await getAccountForUsagePeriod({
        userId,
        usagePeriod: currentUsagePeriod,
        prisma: tx,
      });
    }

    const existing = await tx.creditTransaction.findFirst({
      where: { userId, aiJobId, kind: AI_USAGE_SETTLEMENT_KIND },
    });
    if (existing) return await getAccountForUsagePeriod({
      userId,
      usagePeriod: currentUsagePeriod,
      prisma: tx,
    });

    const storedUsage = await tx.creditTransaction.findFirst({
      where: { userId, aiJobId, kind: "usage" },
    });
    if (!storedUsage) {
      throw new Error(`Usage transaction for AI job ${aiJobId} was not found`);
    }
    const usage = decimalNumbers(storedUsage);
    const reservedAmount = exactUsageAmount(
      usage.usageAmount - usage.creditAmount,
      "reservedAmount",
    );
    if (reservedAmount <= 0) {
      throw new Error(`AI job ${aiJobId} has an invalid reservation`);
    }

    const account = await getAccountForUsagePeriod({
      userId,
      usagePeriod: currentUsagePeriod,
      prisma: tx,
    });
    const transactionPeriod = {
      start: usage.usagePeriodStart,
      end: usage.usagePeriodEnd,
    };
    const samePeriod = usagePeriodsEqual(currentUsagePeriod, transactionPeriod);
    const delta = exactUsageAmount(
      settledAmount - reservedAmount,
      "settlementDelta",
    );
    let usageAmount = 0;
    let creditAmount = 0;
    let debtAmount = 0;
    let monthlyUsageUsed = account.monthlyUsageUsed;
    let purchasedCredits = account.purchasedCredits;
    let purchasedCreditDebt = account.purchasedCreditDebt;

    if (delta < 0) {
      const refund = -delta;
      // consumeUsage spends allowance first, so settlement restores purchased
      // credits first and only then the allowance portion.
      const reservedPurchased = Math.max(-usage.creditAmount, 0);
      const purchasedRestored = Math.min(reservedPurchased, refund);
      const monthlyWanted = refund - purchasedRestored;
      const monthlyRestored = samePeriod
        ? Math.min(monthlyUsageUsed, monthlyWanted)
        : 0;
      const debtPaid = Math.min(purchasedCreditDebt, purchasedRestored);
      purchasedCreditDebt -= debtPaid;
      purchasedCredits += purchasedRestored - debtPaid;
      monthlyUsageUsed -= monthlyRestored;
      // The ledger records the full correction to this job's original period.
      // Counter restoration is separately clamped above: expired allowance
      // must never credit a new period, nor undo an administrator's reset.
      usageAmount = -monthlyWanted;
      creditAmount = purchasedRestored;
      debtAmount = debtPaid === 0 ? 0 : -debtPaid;
    } else if (delta > 0) {
      const monthlyRemaining = samePeriod
        ? Math.max(monthlyUsageLimit - monthlyUsageUsed, 0)
        : 0;
      const monthlyAdded = Math.min(monthlyRemaining, delta);
      const purchasedWanted = delta - monthlyAdded;
      const purchasedAdded = Math.min(purchasedCredits, purchasedWanted);
      const debtAdded = purchasedWanted - purchasedAdded;
      monthlyUsageUsed += monthlyAdded;
      purchasedCredits -= purchasedAdded;
      purchasedCreditDebt += debtAdded;
      usageAmount = monthlyAdded;
      // Include debt in net consumption; debtAmount records which part could
      // not be collected from the current balance.
      creditAmount = -purchasedWanted;
      debtAmount = debtAdded;
    }

    monthlyUsageUsed = exactUsageAmount(monthlyUsageUsed, "monthlyUsageUsed");
    purchasedCredits = exactUsageAmount(purchasedCredits, "purchasedCredits");
    purchasedCreditDebt = exactUsageAmount(
      purchasedCreditDebt,
      "purchasedCreditDebt",
    );
    usageAmount = exactUsageAmount(usageAmount, "usageAmount");
    creditAmount = exactUsageAmount(creditAmount, "creditAmount");
    debtAmount = exactUsageAmount(debtAmount, "debtAmount");

    const updated = decimalNumbers(await tx.creditAccount.update({
      where: { userId },
      data: {
        monthlyUsageUsed,
        purchasedCredits,
        purchasedCreditDebt,
      },
    }));
    if (delta !== 0) {
      await tx.creditTransaction.create({
        data: {
          userId,
          creditAmount,
          debtAmount,
          usageAmount,
          usagePeriodStart: transactionPeriod.start,
          usagePeriodEnd: transactionPeriod.end,
          kind: AI_USAGE_SETTLEMENT_KIND,
          aiJobId,
        },
      });
    }
    await tx.aiJob.update({
      where: { id: aiJobId },
      data: {
        usageUnits: settledAmount,
        providerCostUsdMicros,
        usageSettledAt: new Date(),
      },
    });
    return updated;
  };

  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

// Grant or revoke purchased credits by administrator decision. A grant settles
// outstanding purchased-credit debt first, exactly as a paid top-up does. A
// revoke is rejected when it exceeds the current balance instead of turning
// into debt, because a manual correction must not leave an account owing value
// it never received.
//
// `adjustmentKey` identifies the operator's decision. Every other money-moving
// write in the ledger is bound to something that cannot repeat — a Stripe
// payment, an AI job — but a manual adjustment has no such counterpart, and
// read-modify-write applies twice if the confirmation arrives twice.
// Whether this decision is already in the ledger. adjustPurchasedCreditsByAdmin
// answers a replay by returning the account unchanged, which is indistinguishable
// from having applied it; a caller that records the decision elsewhere has to ask
// first or it writes that record twice for one grant.
export async function findAdminCreditAdjustment({
  adjustmentKey,
  prisma,
}: {
  adjustmentKey: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const adjustment = await db.creditTransaction.findUnique({
    where: {
      adminAdjustmentKey: adjustmentKey,
    },
  });
  return adjustment ? decimalNumbers(adjustment) : null;
}

export async function adjustPurchasedCreditsByAdmin({
  userId,
  creditDelta,
  adjustmentKey,
  prisma,
}: {
  userId: string;
  creditDelta: number;
  adjustmentKey: string;
  prisma?: PrismaTransaction;
}) {
  if (!Number.isSafeInteger(creditDelta) || creditDelta === 0) {
    throw new RangeError("creditDelta must be a non-zero integer");
  }
  if (adjustmentKey.length === 0) {
    throw new RangeError("adjustmentKey must not be empty");
  }

  const run = async (tx: PrismaTransaction) => {
    const storedApplied = await tx.creditTransaction.findUnique({
      where: {
        adminAdjustmentKey: adjustmentKey,
      },
    });
    if (storedApplied) {
      const applied = decimalNumbers(storedApplied);
      // The key is unique across the whole ledger, so a replay that names a
      // different account or a different amount is not the same decision and
      // must not be answered as though it had been applied.
      if (applied.userId !== userId || applied.creditAmount !== creditDelta) {
        throw new CreditAdjustmentRejectedError(
          "conflictingAdjustment",
          `Adjustment key ${adjustmentKey} was already applied with different terms`,
        );
      }
      return await getCreditAccount({ userId, prisma: tx });
    }

    const account = await getCreditAccount({ userId, prisma: tx });
    let creditsDelta: number;
    let debtDelta: number;
    if (creditDelta > 0) {
      const debtPaid = Math.min(account.purchasedCreditDebt, creditDelta);
      creditsDelta = creditDelta - debtPaid;
      debtDelta = debtPaid === 0 ? 0 : -debtPaid;
    } else {
      const revoked = -creditDelta;
      if (account.purchasedCredits < revoked) {
        throw new CreditAdjustmentRejectedError(
          "insufficientCredits",
          `User ${userId} holds fewer than ${revoked} purchased credits`,
        );
      }
      creditsDelta = creditDelta;
      debtDelta = 0;
    }

    const updated = decimalNumbers(await tx.creditAccount.update({
      where: {
        userId,
      },
      data: {
        purchasedCredits: account.purchasedCredits + creditsDelta,
        purchasedCreditDebt: account.purchasedCreditDebt + debtDelta,
      },
    }));

    await tx.creditTransaction.create({
      data: {
        userId,
        creditAmount: creditDelta,
        debtAmount: debtDelta,
        kind: ADMIN_CREDIT_ADJUSTMENT_KIND,
        adminAdjustmentKey: adjustmentKey,
      },
    });

    return updated;
  };

  // A caller-supplied transaction owns its own failure handling: a rejected
  // insert has already aborted it, so nothing can be read back here.
  if (prisma) {
    return await run(prisma);
  }
  try {
    return await startRetryableTransaction(run);
  } catch (error) {
    // The lookup above settles a repeat that arrives after the first one
    // committed. Two that overlap are separated by the unique index instead,
    // and the adjustment the loser was carrying is the one that landed.
    if (isUniqueConstraintViolation(error)) {
      return await getCreditAccount({ userId });
    }
    throw error;
  }
}

// Set the monthly usage counter to an absolute value by administrator
// decision. The absolute form is what an operator can act on, because the
// stored counter is the only thing the balance is derived from. The period is
// synchronized first so an adjustment made after a renewal is not undone by the
// next lazy reset.
export async function setMonthlyUsageUsedByAdmin({
  userId,
  monthlyUsageUsed,
  monthlyUsageLimit,
  usagePeriod,
  expectedMonthlyUsageUsed,
  prisma,
}: {
  userId: string;
  monthlyUsageUsed: number;
  monthlyUsageLimit: number;
  usagePeriod: UsagePeriod;
  // The counter the operator was looking at. An absolute write has no other way
  // to tell a deliberate correction from one that silently erases a job that
  // ran while the confirmation was open.
  expectedMonthlyUsageUsed?: number;
  prisma?: PrismaTransaction;
}) {
  const normalizedMonthlyUsageUsed = normalizeUsageAmount(
    monthlyUsageUsed,
    "monthlyUsageUsed",
    true,
  );
  const normalizedExpectedUsage = expectedMonthlyUsageUsed === undefined
    ? undefined
    : normalizeUsageAmount(
        expectedMonthlyUsageUsed,
        "expectedMonthlyUsageUsed",
        true,
      );
  assertNonNegativeInteger(monthlyUsageLimit, "monthlyUsageLimit");
  if (normalizedMonthlyUsageUsed > monthlyUsageLimit) {
    throw new CreditAdjustmentRejectedError(
      "usageOutOfRange",
      `monthlyUsageUsed must not exceed the ${monthlyUsageLimit} unit allowance`,
    );
  }

  const run = async (tx: PrismaTransaction) => {
    const account = await getAccountForUsagePeriod({
      userId,
      usagePeriod,
      prisma: tx,
    });
    if (
      normalizedExpectedUsage !== undefined &&
      account.monthlyUsageUsed !== normalizedExpectedUsage
    ) {
      throw new CreditAdjustmentRejectedError(
        "staleUsage",
        `monthlyUsageUsed moved from ${normalizedExpectedUsage} to ${account.monthlyUsageUsed} before this adjustment was applied`,
      );
    }
    const delta = exactUsageAmount(
      normalizedMonthlyUsageUsed - account.monthlyUsageUsed,
      "usageAdjustmentDelta",
    );
    if (delta === 0) {
      return account;
    }

    const updated = decimalNumbers(await tx.creditAccount.update({
      where: {
        userId,
      },
      data: {
        monthlyUsageUsed: normalizedMonthlyUsageUsed,
      },
    }));

    await tx.creditTransaction.create({
      data: {
        userId,
        creditAmount: 0,
        usageAmount: delta,
        usagePeriodStart: usagePeriod.start,
        usagePeriodEnd: usagePeriod.end,
        kind: ADMIN_USAGE_ADJUSTMENT_KIND,
      },
    });

    return updated;
  };

  if (prisma) {
    return await run(prisma);
  }
  return await startRetryableTransaction(run);
}

// Restore the exact split recorded by consumeUsage. Included usage is restored
// only while its billing period is still current; purchased credits never expire.
export async function refundUsage({
  userId,
  usagePeriod,
  aiJobId,
  prisma,
}: {
  userId: string;
  usagePeriod: UsagePeriod;
  aiJobId: string;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    const account = await getAccountForUsagePeriod({
      userId,
      usagePeriod,
      prisma: tx,
    });
    const existingRefund = await tx.creditTransaction.findFirst({
      where: {
        userId,
        aiJobId,
        kind: "refund",
      },
    });
    if (existingRefund) {
      return account;
    }

    const storedUsage = await tx.creditTransaction.findFirst({
      where: {
        userId,
        aiJobId,
        kind: "usage",
      },
    });
    if (!storedUsage) {
      throw new Error(`Usage transaction for AI job ${aiJobId} was not found`);
    }
    const usage = decimalNumbers(storedUsage);

    const transactionPeriod = {
      start: usage.usagePeriodStart,
      end: usage.usagePeriodEnd,
    };
    const monthlyRestored = usagePeriodsEqual(usagePeriod, transactionPeriod)
      ? Math.min(account.monthlyUsageUsed, Math.max(usage.usageAmount, 0))
      : 0;
    const purchasedRestored = Math.max(-usage.creditAmount, 0);
    const debtPaid = Math.min(
      account.purchasedCreditDebt,
      purchasedRestored,
    );
    const creditsRestored = purchasedRestored - debtPaid;

    const updated = decimalNumbers(await tx.creditAccount.update({
      where: {
        userId,
      },
      data: {
        monthlyUsageUsed: exactUsageAmount(
          account.monthlyUsageUsed - monthlyRestored,
          "monthlyUsageUsed",
        ),
        purchasedCredits: exactUsageAmount(
          account.purchasedCredits + creditsRestored,
          "purchasedCredits",
        ),
        purchasedCreditDebt: exactUsageAmount(
          account.purchasedCreditDebt - debtPaid,
          "purchasedCreditDebt",
        ),
      },
    }));

    await tx.creditTransaction.create({
      data: {
        userId,
        creditAmount: purchasedRestored,
        debtAmount: debtPaid === 0 ? 0 : -debtPaid,
        usageAmount: monthlyRestored === 0 ? 0 : -monthlyRestored,
        usagePeriodStart: transactionPeriod.start,
        usagePeriodEnd: transactionPeriod.end,
        kind: "refund",
        aiJobId,
      },
    });

    return updated;
  };

  if (prisma) {
    return await run(prisma);
  }
  return await startRetryableTransaction(run);
}
