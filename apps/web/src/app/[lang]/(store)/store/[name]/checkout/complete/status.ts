import {
  PACKAGE_PAYMENT_EVENT_RANK,
  type PackagePaymentRecord,
} from "@beutl/db";
import type Stripe from "stripe";

export type PackageCheckoutCompletionStatus =
  | Stripe.PaymentIntent.Status
  | "refunded";

export function resolvePackageCheckoutCompletionStatus(
  paymentIntentStatus: Stripe.PaymentIntent.Status,
  payment: PackagePaymentRecord | null,
): PackageCheckoutCompletionStatus {
  if (paymentIntentStatus !== "succeeded") {
    return paymentIntentStatus;
  }
  if (payment?.fulfillmentValidated && !payment.revokedAt) {
    return "succeeded";
  }
  if (
    payment?.revokedAt &&
    payment.stripeStateEventRank === PACKAGE_PAYMENT_EVENT_RANK.refundSucceeded
  ) {
    return "refunded";
  }
  return "processing";
}
