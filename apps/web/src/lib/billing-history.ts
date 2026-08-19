import { formatAmount, formatCount, formatDate } from "@beutl/core";
import { formatBillingProductLabel } from "./billing-product";
import type {
  BillingDocumentLink,
  SubscriptionPaymentRecord,
} from "./stripe/billing-documents";

export function packagePaymentReversalTranslationKey(payment: {
  revokedAt: Date | null;
}): "account:billing.paymentReversed" | null {
  return payment.revokedAt === null ? null : "account:billing.paymentReversed";
}

export type BillingHistoryEntry = {
  id: string;
  kind: "subscription" | "package" | "credit";
  paidAt: Date;
  product: string;
  detail: string | null;
  // null when the charge predates amount capture, or when a revocation created
  // the row before its success event arrived.
  amount: { value: number; currency: string } | null;
  reversalNote: string | null;
  // null when Stripe could not be reached, or when the payment is older than
  // the window the document lookup covers.
  document: BillingDocumentLink | null;
};

type PackagePaymentRow = {
  id: string;
  paymentId: string;
  packageId: string;
  stripePaymentAmount: number | null;
  stripeCurrency: string | null;
  revokedAt: Date | null;
  createdAt: Date;
};

type CreditPurchaseRow = {
  id: string;
  stripePaymentId: string | null;
  creditAmount: number;
  stripePaymentAmount: number | null;
  stripeCurrency: string | null;
  reversedCredits: number;
  isFullyReversed: boolean;
  createdAt: Date;
};

type PackageSummary = {
  name: string;
  displayName: string | null;
  user: {
    name: string | null;
    Profile: { displayName: string | null } | null;
  };
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

function creditReversalNote(
  purchase: CreditPurchaseRow,
  t: Translate,
  lang: string,
): string | null {
  if (purchase.isFullyReversed) {
    return t("account:billing.creditPurchaseRefunded");
  }
  if (purchase.reversedCredits > 0) {
    return t("account:billing.creditPurchasePartiallyRefunded", {
      credits: formatCount(purchase.reversedCredits, lang),
    });
  }
  return null;
}

function subscriptionReversalNote(
  payment: SubscriptionPaymentRecord,
  t: Translate,
  lang: string,
): string | null {
  if (payment.disputed || payment.refundedAmount >= payment.amount.value) {
    return t("account:billing.paymentReversed");
  }
  if (payment.refundedAmount > 0) {
    return t("account:billing.paymentPartiallyRefunded", {
      amount: formatAmount(
        payment.refundedAmount,
        payment.amount.currency,
        lang,
      ),
    });
  }
  return null;
}

// Merges the money-in ledgers into one display list. Subscription payments come
// from Stripe rather than a local table, so they arrive already resolved; the
// builder itself stays free of I/O, which is what stops the per-row Stripe
// lookup from returning.
export function buildBillingHistory({
  subscriptionPayments,
  payments,
  creditPurchases,
  packagesById,
  documentByPaymentIntentId,
  t,
  lang,
}: {
  subscriptionPayments: readonly SubscriptionPaymentRecord[];
  payments: readonly PackagePaymentRow[];
  creditPurchases: readonly CreditPurchaseRow[];
  packagesById: ReadonlyMap<string, PackageSummary>;
  documentByPaymentIntentId: ReadonlyMap<string, BillingDocumentLink>;
  t: Translate;
  lang: string;
}): BillingHistoryEntry[] {
  const subscriptionEntries = subscriptionPayments.map(
    (payment): BillingHistoryEntry => ({
      id: payment.id,
      kind: "subscription",
      paidAt: payment.paidAt,
      product: formatBillingProductLabel(t, payment.product),
      detail: t("account:billing.subscriptionPeriod", {
        start: formatDate(payment.periodStart, lang),
        end: formatDate(payment.periodEnd, lang),
      }),
      amount: payment.amount,
      reversalNote: subscriptionReversalNote(payment, t, lang),
      document: payment.document,
    }),
  );

  const packageEntries = payments.map((payment): BillingHistoryEntry => {
    const pkg = packagesById.get(payment.packageId);
    const reversalKey = packagePaymentReversalTranslationKey(payment);
    return {
      id: payment.id,
      kind: "package",
      paidAt: payment.createdAt,
      // UserPaymentHistory holds no relation to Package, so the only realistic
      // reason a lookup misses is that the package was deleted.
      product: pkg
        ? pkg.displayName || pkg.name
        : t("account:billing.unknownPackage"),
      detail:
        pkg?.user.Profile?.displayName ||
        pkg?.user.name ||
        t("account:billing.unknownSeller"),
      amount:
        payment.stripePaymentAmount !== null && payment.stripeCurrency !== null
          ? {
              value: payment.stripePaymentAmount,
              currency: payment.stripeCurrency,
            }
          : null,
      reversalNote: reversalKey ? t(reversalKey) : null,
      document: documentByPaymentIntentId.get(payment.paymentId) ?? null,
    };
  });

  // Credit top-ups are money-in events and belong in the payment history. The
  // usage side of the credit ledger stays out of the UI so a user cannot infer
  // what each AI operation costs.
  const creditEntries = creditPurchases.map(
    (purchase): BillingHistoryEntry => ({
      id: purchase.id,
      kind: "credit",
      paidAt: purchase.createdAt,
      product: t("account:billing.creditPurchase"),
      // The purchased quantity is a fixed amount the user paid for, not a
      // per-operation cost, so it is safe to show.
      detail: t("account:billing.creditPurchaseAmount", {
        credits: formatCount(purchase.creditAmount, lang),
      }),
      // A purchase written before the charge was captured has no amount to
      // show, but dropping the row hides a receipt the user paid for. The
      // package branch above renders the same state as an em dash.
      amount:
        purchase.stripePaymentAmount !== null &&
        purchase.stripeCurrency !== null
          ? {
              value: purchase.stripePaymentAmount,
              currency: purchase.stripeCurrency,
            }
          : null,
      reversalNote: creditReversalNote(purchase, t, lang),
      document: purchase.stripePaymentId
        ? documentByPaymentIntentId.get(purchase.stripePaymentId) ?? null
        : null,
    }),
  );

  return [...subscriptionEntries, ...packageEntries, ...creditEntries].sort(
    (left, right) => right.paidAt.getTime() - left.paidAt.getTime(),
  );
}
