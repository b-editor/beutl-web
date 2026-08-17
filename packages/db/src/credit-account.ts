import { getDb } from "./provider";
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
    readonly reason: "insufficientCredits" | "usageOutOfRange",
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

function periodsEqual(
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
  const account = await prisma.creditAccount.upsert({
    where: {
      userId,
    },
    create: {
      userId,
      usagePeriodStart: usagePeriod.start,
      usagePeriodEnd: usagePeriod.end,
    },
    update: {},
  });

  const storedPeriod = {
    start: account.usagePeriodStart,
    end: account.usagePeriodEnd,
  };
  if (!periodsEqual(storedPeriod, usagePeriod)) {
    return await prisma.creditAccount.update({
      where: {
        userId,
      },
      data: {
        monthlyUsageUsed: 0,
        usagePeriodStart: usagePeriod.start,
        usagePeriodEnd: usagePeriod.end,
      },
    });
  }

  // Refresh period metadata without resetting usage when Stripe only adjusted
  // the end or a newly available start was backfilled.
  if (
    !datesEqual(account.usagePeriodStart, usagePeriod.start) ||
    !datesEqual(account.usagePeriodEnd, usagePeriod.end)
  ) {
    return await prisma.creditAccount.update({
      where: {
        userId,
      },
      data: {
        usagePeriodStart: usagePeriod.start,
        usagePeriodEnd: usagePeriod.end,
      },
    });
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
  return await db.creditAccount.upsert({
    where: {
      userId,
    },
    create: {
      userId,
    },
    update: {},
  });
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
  const purchase = await prisma.creditTransaction.findUnique({
    where: {
      stripePaymentId,
    },
  });
  if (!purchase) {
    return null;
  }
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
    return await prisma.creditTransaction.update({
      where: {
        id: purchase.id,
      },
      data: {
        stripePaymentAmount: stripePayment.amount,
        stripeCurrency: currency,
        stripeSourcePaymentId: stripePaymentId,
      },
    });
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
  const processed = await prisma.creditTransaction.findUnique({
    where: {
      stripeReversalKind_stripeReversalId_stripeReversalRevision: {
        stripeReversalKind: reversalKind,
        stripeReversalId: reversalId,
        stripeReversalRevision: reversalRevision,
      },
    },
  });
  if (processed) {
    return await getCreditAccount({ userId: processed.userId, prisma });
  }

  const purchase = await prisma.creditTransaction.findUnique({
    where: {
      stripePaymentId,
    },
  });
  if (!purchase) {
    return null;
  }
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

  const adjustments = await prisma.creditTransaction.findMany({
    where: {
      stripeSourcePaymentId: stripePaymentId,
      kind: PURCHASE_REVERSAL_TRANSACTION_KIND,
    },
  });
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
    updated = await prisma.creditAccount.update({
      where: {
        userId: purchase.userId,
      },
      data: {
        purchasedCredits: account.purchasedCredits - creditsConsumed,
        purchasedCreditDebt: account.purchasedCreditDebt + debtAdded,
      },
    });
  } else if (reversalDelta < 0) {
    const restoredAmount = -reversalDelta;
    const debtPaid = Math.min(account.purchasedCreditDebt, restoredAmount);
    const creditsRestored = restoredAmount - debtPaid;
    creditAmount = restoredAmount;
    debtAmount = debtPaid === 0 ? 0 : -debtPaid;
    updated = await prisma.creditAccount.update({
      where: {
        userId: purchase.userId,
      },
      data: {
        purchasedCredits: account.purchasedCredits + creditsRestored,
        purchasedCreditDebt: account.purchasedCreditDebt - debtPaid,
      },
    });
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
    const existing = await tx.creditTransaction.findUnique({
      where: {
        stripePaymentId,
      },
    });
    if (existing) {
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
    const updated = await tx.creditAccount.update({
      where: {
        userId,
      },
      data: {
        purchasedCredits: account.purchasedCredits + creditsAdded,
        purchasedCreditDebt: account.purchasedCreditDebt - debtPaid,
      },
    });

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
  assertPositiveInteger(amount, "amount");
  assertNonNegativeInteger(monthlyUsageLimit, "monthlyUsageLimit");

  const run = async (tx: PrismaTransaction) => {
    const account = await getAccountForUsagePeriod({
      userId,
      usagePeriod,
      prisma: tx,
    });
    const existingUsage = await tx.creditTransaction.findFirst({
      where: {
        userId,
        aiJobId,
        kind: "usage",
      },
    });
    if (existingUsage) {
      const existingAmount =
        existingUsage.usageAmount - existingUsage.creditAmount;
      if (existingAmount !== amount) {
        throw new Error(
          `AI job ${aiJobId} already has a different usage charge`,
        );
      }
      return account;
    }

    const monthlyRemaining = Math.max(
      monthlyUsageLimit - account.monthlyUsageUsed,
      0,
    );
    const monthlyUsed = Math.min(monthlyRemaining, amount);
    const purchasedUsed = amount - monthlyUsed;
    if (account.purchasedCredits < purchasedUsed) {
      throw new AiUsageLimitExceededError();
    }

    const updated = await tx.creditAccount.update({
      where: {
        userId,
      },
      data: {
        monthlyUsageUsed: account.monthlyUsageUsed + monthlyUsed,
        purchasedCredits: account.purchasedCredits - purchasedUsed,
      },
    });

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

// Grant or revoke purchased credits by administrator decision. A grant settles
// outstanding purchased-credit debt first, exactly as a paid top-up does. A
// revoke is rejected when it exceeds the current balance instead of turning
// into debt, because a manual correction must not leave an account owing value
// it never received.
export async function adjustPurchasedCreditsByAdmin({
  userId,
  creditDelta,
  prisma,
}: {
  userId: string;
  creditDelta: number;
  prisma?: PrismaTransaction;
}) {
  if (!Number.isSafeInteger(creditDelta) || creditDelta === 0) {
    throw new RangeError("creditDelta must be a non-zero integer");
  }

  const run = async (tx: PrismaTransaction) => {
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

    const updated = await tx.creditAccount.update({
      where: {
        userId,
      },
      data: {
        purchasedCredits: account.purchasedCredits + creditsDelta,
        purchasedCreditDebt: account.purchasedCreditDebt + debtDelta,
      },
    });

    await tx.creditTransaction.create({
      data: {
        userId,
        creditAmount: creditDelta,
        debtAmount: debtDelta,
        kind: ADMIN_CREDIT_ADJUSTMENT_KIND,
      },
    });

    return updated;
  };

  if (prisma) {
    return await run(prisma);
  }
  return await startRetryableTransaction(run);
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
  prisma,
}: {
  userId: string;
  monthlyUsageUsed: number;
  monthlyUsageLimit: number;
  usagePeriod: UsagePeriod;
  prisma?: PrismaTransaction;
}) {
  assertNonNegativeInteger(monthlyUsageUsed, "monthlyUsageUsed");
  assertNonNegativeInteger(monthlyUsageLimit, "monthlyUsageLimit");
  if (monthlyUsageUsed > monthlyUsageLimit) {
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
    const delta = monthlyUsageUsed - account.monthlyUsageUsed;
    if (delta === 0) {
      return account;
    }

    const updated = await tx.creditAccount.update({
      where: {
        userId,
      },
      data: {
        monthlyUsageUsed,
      },
    });

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

    const usage = await tx.creditTransaction.findFirst({
      where: {
        userId,
        aiJobId,
        kind: "usage",
      },
    });
    if (!usage) {
      throw new Error(`Usage transaction for AI job ${aiJobId} was not found`);
    }

    const transactionPeriod = {
      start: usage.usagePeriodStart,
      end: usage.usagePeriodEnd,
    };
    const monthlyRestored = periodsEqual(usagePeriod, transactionPeriod)
      ? Math.min(account.monthlyUsageUsed, Math.max(usage.usageAmount, 0))
      : 0;
    const purchasedRestored = Math.max(-usage.creditAmount, 0);
    const debtPaid = Math.min(
      account.purchasedCreditDebt,
      purchasedRestored,
    );
    const creditsRestored = purchasedRestored - debtPaid;

    const updated = await tx.creditAccount.update({
      where: {
        userId,
      },
      data: {
        monthlyUsageUsed: account.monthlyUsageUsed - monthlyRestored,
        purchasedCredits: account.purchasedCredits + creditsRestored,
        purchasedCreditDebt: account.purchasedCreditDebt - debtPaid,
      },
    });

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
