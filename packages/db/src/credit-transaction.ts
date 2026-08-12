import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

export async function getCreditTransactionsByUserId({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.creditTransaction.findMany({
    where: {
      userId,
    },
    orderBy: {
      createdAt: "desc",
    },
  });
}

// Only the money-in side of the credit ledger. Usage rows are deliberately
// excluded so the billing history never exposes the per-operation usage cost.
// Each purchase carries how many of its credits were later reversed by a refund
// or dispute, so the history can show that the purchase no longer stands.
export async function getCreditPurchasesByUserId({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const purchases = await db.creditTransaction.findMany({
    where: {
      userId,
      kind: "purchase",
      stripePaymentId: { not: null },
    },
    orderBy: {
      createdAt: "desc",
    },
  });
  if (purchases.length === 0) {
    return [];
  }

  const reversals = await db.creditTransaction.findMany({
    where: {
      userId,
      kind: "purchase_reversal",
    },
  });
  const reversedByPayment = new Map<string, number>();
  for (const reversal of reversals) {
    const paymentId = reversal.stripeSourcePaymentId;
    if (!paymentId) {
      continue;
    }
    // Reversal rows carry a negative creditAmount; a later restore is positive.
    reversedByPayment.set(
      paymentId,
      (reversedByPayment.get(paymentId) ?? 0) - reversal.creditAmount,
    );
  }

  return purchases.map((purchase) => {
    const reversedCredits = Math.max(
      reversedByPayment.get(purchase.stripePaymentId as string) ?? 0,
      0,
    );
    return {
      ...purchase,
      reversedCredits,
      isFullyReversed:
        reversedCredits > 0 && reversedCredits >= purchase.creditAmount,
    };
  });
}

export async function existsCreditTransactionByStripePaymentId({
  stripePaymentId,
  prisma,
}: {
  stripePaymentId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return !!(await db.creditTransaction.findUnique({
    where: {
      stripePaymentId,
    },
    select: {
      id: true,
    },
  }));
}

export async function findCreditPurchaseByStripePaymentId({
  stripePaymentId,
  prisma,
}: {
  stripePaymentId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.creditTransaction.findFirst({
    where: {
      stripePaymentId,
      kind: "purchase",
    },
    select: {
      userId: true,
      creditAmount: true,
      billingOfferId: true,
      topUpCheckoutAttemptId: true,
      stripePaymentAmount: true,
      stripeCurrency: true,
    },
  });
}
