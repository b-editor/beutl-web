import { hasStripeOwnerMetadata, stripeOwnerMetadata } from "./ownership";
import type Stripe from "stripe";

export const PACKAGE_PURCHASE_METADATA_VALUE = "package";

export function packagePaymentIntentMetadata(
  userId: string,
  packageId: string,
): Record<string, string> {
  return {
    ...stripeOwnerMetadata(userId),
    beutlPurchaseKind: PACKAGE_PURCHASE_METADATA_VALUE,
    packageId,
  };
}

export type PackagePurchaseExpectation = {
  customerId: string;
  userId: string;
  packageId: string;
  amount?: number;
  currency?: string;
};

function hasPackagePurchaseOwnership(
  metadata: Stripe.Metadata | null,
  { userId, packageId }: Pick<PackagePurchaseExpectation, "userId" | "packageId">,
): boolean {
  return (
    metadata?.beutlPurchaseKind === PACKAGE_PURCHASE_METADATA_VALUE &&
    metadata.packageId === packageId &&
    hasStripeOwnerMetadata(metadata, userId)
  );
}

function matchesPrice(
  actual: { amount: number | null; currency: string | null },
  expected: Pick<PackagePurchaseExpectation, "amount" | "currency">,
): boolean {
  return (
    (expected.amount === undefined || actual.amount === expected.amount) &&
    (expected.currency === undefined ||
      actual.currency?.toLowerCase() === expected.currency.toLowerCase())
  );
}

export function isOwnedPackagePaymentIntent(
  paymentIntent: Pick<
    Stripe.PaymentIntent,
    "amount" | "currency" | "customer" | "metadata"
  >,
  expected: PackagePurchaseExpectation,
): boolean {
  const paymentCustomerId =
    typeof paymentIntent.customer === "string"
      ? paymentIntent.customer
      : paymentIntent.customer?.id;
  return (
    paymentCustomerId === expected.customerId &&
    hasPackagePurchaseOwnership(paymentIntent.metadata, expected) &&
    matchesPrice(
      { amount: paymentIntent.amount, currency: paymentIntent.currency },
      expected,
    )
  );
}

// 未払いの Checkout Session を使い回してよいかの判定。同じ買い物で毎回セッションを
// 作ると、タブを開き直しただけで二重の支払い口ができてしまう。
export function isOwnedPackageCheckoutSession(
  checkoutSession: Pick<
    Stripe.Checkout.Session,
    "amount_total" | "currency" | "customer" | "metadata" | "mode"
  >,
  expected: PackagePurchaseExpectation,
): boolean {
  const sessionCustomerId =
    typeof checkoutSession.customer === "string"
      ? checkoutSession.customer
      : checkoutSession.customer?.id;
  return (
    checkoutSession.mode === "payment" &&
    sessionCustomerId === expected.customerId &&
    hasPackagePurchaseOwnership(checkoutSession.metadata, expected) &&
    matchesPrice(
      {
        amount: checkoutSession.amount_total,
        currency: checkoutSession.currency,
      },
      expected,
    )
  );
}
