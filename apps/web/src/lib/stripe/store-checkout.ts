import {
  hasStripeOwnerMetadata,
  stripeOwnerMetadata,
  STRIPE_APPLICATION_METADATA_VALUE,
} from "./ownership";
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

export function packagePaymentIntentSearchQuery({
  customerId,
  userId,
  packageId,
  amount,
  currency,
}: {
  customerId: string;
  userId: string;
  packageId: string;
  amount: number;
  currency: string;
}): string {
  return `customer:"${customerId}" AND metadata["beutlApplication"]:"${STRIPE_APPLICATION_METADATA_VALUE}" AND metadata["beutlPurchaseKind"]:"${PACKAGE_PURCHASE_METADATA_VALUE}" AND metadata["beutlUserId"]:"${userId}" AND metadata["packageId"]:"${packageId}" AND amount:${amount} AND currency:"${currency.toLowerCase()}" AND status:"requires_payment_method"`;
}

export function isOwnedPackagePaymentIntent(
  paymentIntent: Pick<
    Stripe.PaymentIntent,
    "amount" | "currency" | "customer" | "metadata"
  >,
  {
    customerId,
    userId,
    packageId,
    amount,
    currency,
  }: {
    customerId: string;
    userId: string;
    packageId: string;
    amount?: number;
    currency?: string;
  },
): boolean {
  const paymentCustomerId =
    typeof paymentIntent.customer === "string"
      ? paymentIntent.customer
      : paymentIntent.customer?.id;
  return (
    paymentCustomerId === customerId &&
    paymentIntent.metadata.beutlPurchaseKind ===
      PACKAGE_PURCHASE_METADATA_VALUE &&
    paymentIntent.metadata.packageId === packageId &&
    hasStripeOwnerMetadata(paymentIntent.metadata, userId) &&
    (amount === undefined || paymentIntent.amount === amount) &&
    (currency === undefined ||
      paymentIntent.currency.toLowerCase() === currency.toLowerCase())
  );
}
