import {
  AI_TOP_UP,
  getCanonicalPaymentRefundState,
} from "@beutl/api";
import {
  allowsStripePromotionCodes,
  isValidStripeCheckoutAmount,
} from "@beutl/core";
import {
  activateBillingOffer,
  findTopUpCheckoutAttempt,
  fulfillTopUpCheckoutAttempt,
  recordTopUpRefund,
  requireTopUpRefund,
  type BillingOfferTerms,
} from "@beutl/db";
import { hasStripeOwnerMetadata } from "./ownership";
import type Stripe from "stripe";

type VersionedSubscription = Stripe.Subscription & {
  current_period_start?: number | null;
  current_period_end?: number | null;
};

export type BillingOfferRecord = BillingOfferTerms & {
  id: string;
  checkoutEnabled: boolean;
};

export function getSubscriptionPeriod(subscription: VersionedSubscription) {
  const item = subscription.items.data[0];
  const start = item?.current_period_start ?? subscription.current_period_start;
  const end = item?.current_period_end ?? subscription.current_period_end;
  return {
    currentPeriodStart: start ? new Date(start * 1000) : null,
    currentPeriodEnd: end ? new Date(end * 1000) : null,
  };
}

function getExpandableId(
  value: string | { id: string } | null | undefined,
): string | null {
  return typeof value === "string" ? value : value?.id ?? null;
}

// The one-time credit top-up. Subscription offers (AI Pro, storage) resolve
// through subscription-billing.ts.
function topUpTermsFromPrice(price: Stripe.Price): BillingOfferTerms {
  const stripeProductId = getExpandableId(price.product);
  if (!price.active || price.unit_amount === null || !stripeProductId) {
    throw new Error(
      `Stripe Price ${price.id} is not a valid fixed-price billing offer`,
    );
  }
  if (price.type !== "one_time") {
    throw new Error("STRIPE_CREDIT_PRICE_ID must identify a one-time Price");
  }
  return {
    kind: "top_up",
    stripePriceId: price.id,
    stripeProductId,
    unitAmount: price.unit_amount,
    currency: price.currency,
    creditAmount: AI_TOP_UP.credits,
    recurringInterval: null,
    recurringIntervalCount: null,
  };
}

export async function activateConfiguredTopUpOffer(stripe: Stripe) {
  const priceId = process.env.STRIPE_CREDIT_PRICE_ID;
  if (!priceId) {
    throw new Error("STRIPE_CREDIT_PRICE_ID is not set");
  }
  const price = await stripe.prices.retrieve(priceId);
  return await activateBillingOffer({ terms: topUpTermsFromPrice(price) });
}

export function topUpPaymentMatchesOffer(
  paymentIntent: Stripe.PaymentIntent,
  offer: BillingOfferRecord,
  promotionCodesEnabled = false,
): boolean {
  return (
    offer.kind === "top_up" &&
    paymentIntent.metadata?.billingOfferId === offer.id &&
    paymentIntent.amount_received === paymentIntent.amount &&
    isValidStripeCheckoutAmount(
      paymentIntent.amount,
      offer.unitAmount,
      promotionCodesEnabled,
    ) &&
    paymentIntent.currency.toLowerCase() === offer.currency.toLowerCase() &&
    Number(paymentIntent.metadata?.creditAmount) === offer.creditAmount
  );
}

export async function resolveTopUpPayment(
  paymentIntent: Stripe.PaymentIntent,
) {
  const attemptId = paymentIntent.metadata?.topUpAttemptId;
  if (!attemptId) {
    return null;
  }
  const attempt = await findTopUpCheckoutAttempt({ attemptId });
  const customerId = getExpandableId(paymentIntent.customer);
  if (
    !attempt ||
    !customerId ||
    customerId !== attempt.stripeCustomerId ||
    paymentIntent.metadata?.billingOfferId !== attempt.billingOfferId ||
    !hasStripeOwnerMetadata(paymentIntent.metadata, attempt.ownerUserId) ||
    attempt.billingOffer.kind !== "top_up" ||
    !topUpPaymentMatchesOffer(
      paymentIntent,
      attempt.billingOffer as BillingOfferRecord,
      allowsStripePromotionCodes(attempt.paramsJson),
    )
  ) {
    return { status: "invalid" as const, attempt };
  }
  return { status: "recognized" as const, attempt };
}

export async function fulfillOrRefundTopUpPayment(
  stripe: Stripe,
  paymentIntent: Stripe.PaymentIntent,
) {
  if (paymentIntent.status !== "succeeded") {
    return { status: "pending" as const };
  }
  const resolution = await resolveTopUpPayment(paymentIntent);
  if (!resolution?.attempt) {
    return { status: "unrecognized" as const };
  }

  let canonical = await getCanonicalPaymentRefundState({
    stripe,
    stripePaymentIntentId: paymentIntent.id,
  });

  if (resolution?.status === "recognized") {
    const fulfillment = await fulfillTopUpCheckoutAttempt({
      attemptId: resolution.attempt.id,
      stripePaymentIntentId: paymentIntent.id,
      stripePayment: {
        amount: paymentIntent.amount_received,
        currency: paymentIntent.currency,
      },
      stripeRefundState: {
        succeededAmount: canonical.succeededAmount,
        pendingAmount: canonical.pendingAmount,
      },
    });
    if (
      fulfillment.status === "fulfilled" ||
      fulfillment.status === "already-fulfilled"
    ) {
      return fulfillment;
    }
    if (fulfillment.status === "recovery-pending") {
      return { status: "pending" as const };
    }
    if (fulfillment.status === "duplicate-refund-required") {
      return { status: "refund-requested" as const, refundId: null };
    }
  }

  const attempt = resolution.attempt;
  await requireTopUpRefund({
    attemptId: attempt.id,
    stripePaymentIntentId: paymentIntent.id,
  });
  const managedRefund = canonical.refunds.find(
    (item) => item.metadata?.topUpAttemptId === attempt.id,
  ) ?? null;
  await recordTopUpRefund({
    attemptId: attempt.id,
    stripePaymentIntentId: paymentIntent.id,
    refundId: managedRefund?.id ?? null,
    refundStatus: managedRefund?.status ?? null,
    refundTargetAmount: canonical.targetAmount,
    refundSucceededAmount: canonical.succeededAmount,
    refundPendingAmount: canonical.pendingAmount,
    refundCurrency: canonical.currency,
  });
  if (
    canonical.fullyRefunded ||
    canonical.pendingAmount > 0 ||
    managedRefund?.status === "failed" ||
    managedRefund?.status === "canceled" ||
    managedRefund?.status === "requires_action"
  ) {
    return {
      status: "refund-requested" as const,
      refundId: managedRefund?.id ?? null,
    };
  }
  const refund = await stripe.refunds.create(
    {
      payment_intent: paymentIntent.id,
      amount: canonical.refundableAmount,
      metadata: {
        beutlDisposition: "unfulfillable-ai-top-up",
        topUpAttemptId: attempt.id,
        refundTargetAmount: String(canonical.targetAmount),
        refundSucceededAmountBeforeCreate: String(canonical.succeededAmount),
      },
    },
    {
      idempotencyKey:
        `beutl:ai-top-up-refund:${attempt.id}:${canonical.succeededAmount}:${canonical.refundableAmount}`,
    },
  );
  canonical = await getCanonicalPaymentRefundState({
    stripe,
    stripePaymentIntentId: paymentIntent.id,
  });
  await recordTopUpRefund({
    attemptId: attempt.id,
    stripePaymentIntentId: paymentIntent.id,
    refundId: refund.id,
    refundStatus: refund.status ?? "unknown",
    refundTargetAmount: canonical.targetAmount,
    refundSucceededAmount: canonical.succeededAmount,
    refundPendingAmount: canonical.pendingAmount,
    refundCurrency: canonical.currency,
  });
  return { status: "refund-requested" as const, refundId: refund.id };
}
