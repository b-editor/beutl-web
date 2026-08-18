import { formatCount } from "@beutl/core";

export function packagePaymentReversalTranslationKey(payment: {
  revokedAt: Date | null;
}): "account:billing.packagePurchaseReversed" | null {
  return payment.revokedAt === null
    ? null
    : "account:billing.packagePurchaseReversed";
}

export type BillingHistoryEntry = {
  id: string;
  kind: "package" | "credit";
  paidAt: Date;
  product: string;
  detail: string | null;
  // null when the charge predates amount capture, or when a revocation created
  // the row before its success event arrived.
  amount: { value: number; currency: string } | null;
  reversalNote: string | null;
};

type PackagePaymentRow = {
  id: string;
  packageId: string;
  stripePaymentAmount: number | null;
  stripeCurrency: string | null;
  revokedAt: Date | null;
  createdAt: Date;
};

type CreditPurchaseRow = {
  id: string;
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

// Merges the two money-in ledgers into one display list. Deliberately takes no
// Stripe client: every amount it needs is already on the rows, and keeping the
// signature free of I/O is what stops the per-row Stripe lookup from returning.
export function buildBillingHistory({
  payments,
  creditPurchases,
  packagesById,
  t,
  lang,
}: {
  payments: readonly PackagePaymentRow[];
  creditPurchases: readonly CreditPurchaseRow[];
  packagesById: ReadonlyMap<string, PackageSummary>;
  t: Translate;
  lang: string;
}): BillingHistoryEntry[] {
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
    }),
  );

  return [...packageEntries, ...creditEntries].sort(
    (left, right) => right.paidAt.getTime() - left.paidAt.getTime(),
  );
}
