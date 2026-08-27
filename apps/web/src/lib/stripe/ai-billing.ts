import {
  AI_TOP_UP,
  getCanonicalPaymentRefundState,
  PRO_PLAN,
} from "@beutl/api";
import {
  activateBillingOffer,
  findBillingOfferByStripePriceId,
  findTopUpCheckoutAttempt,
  fulfillTopUpCheckoutAttempt,
  recordTopUpRefund,
  registerHistoricalBillingOffer,
  requireTopUpRefund,
  type BillingOfferKind,
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

function historicalProOffers(): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  const configured = process.env.STRIPE_PRO_HISTORICAL_OFFERS?.trim();
  if (!configured) return result;
  for (const entry of configured.split(",")) {
    const [priceId, productId, ...extra] = entry.split(":").map((part) =>
      part.trim()
    );
    if (
      !priceId ||
      !productId ||
      extra.length > 0 ||
      result.has(priceId)
    ) {
      throw new Error(
        "STRIPE_PRO_HISTORICAL_OFFERS must contain unique priceId:productId pairs",
      );
    }
    result.set(priceId, productId);
  }
  return result;
}

export function configuredProPriceIds(): ReadonlySet<string> {
  const result = new Set(historicalProOffers().keys());
  const currentPriceId = process.env.STRIPE_PRO_PRICE_ID?.trim();
  if (currentPriceId) result.add(currentPriceId);
  return result;
}

function termsFromPrice(
  price: Stripe.Price,
  kind: BillingOfferKind,
  requireActive: boolean,
): BillingOfferTerms {
  const stripeProductId = getExpandableId(price.product);
  if (
    (requireActive && !price.active) ||
    price.unit_amount === null ||
    !stripeProductId
  ) {
    throw new Error(
      `Stripe Price ${price.id} is not a valid fixed-price billing offer`,
    );
  }

  if (kind === "pro") {
    if (
      price.type !== "recurring" ||
      price.recurring?.interval !== "month" ||
      price.recurring.interval_count !== 1
    ) {
      throw new Error("STRIPE_PRO_PRICE_ID must identify a monthly recurring Price");
    }
    return {
      kind,
      stripePriceId: price.id,
      stripeProductId,
      unitAmount: price.unit_amount,
      currency: price.currency,
      creditAmount: null,
      recurringInterval: "month",
      recurringIntervalCount: 1,
    };
  }

  if (price.type !== "one_time") {
    throw new Error("STRIPE_CREDIT_PRICE_ID must identify a one-time Price");
  }
  return {
    kind,
    stripePriceId: price.id,
    stripeProductId,
    unitAmount: price.unit_amount,
    currency: price.currency,
    creditAmount: AI_TOP_UP.credits,
    recurringInterval: null,
    recurringIntervalCount: null,
  };
}

async function activateConfiguredOffer(
  stripe: Stripe,
  kind: BillingOfferKind,
  priceId: string | undefined,
) {
  if (!priceId) {
    throw new Error(
      kind === "pro"
        ? "STRIPE_PRO_PRICE_ID is not set"
        : "STRIPE_CREDIT_PRICE_ID is not set",
    );
  }
  const price = await stripe.prices.retrieve(priceId);
  return await activateBillingOffer({
    terms: termsFromPrice(price, kind, true),
  });
}

export async function activateConfiguredProOffer(stripe: Stripe) {
  return await activateConfiguredOffer(
    stripe,
    "pro",
    process.env.STRIPE_PRO_PRICE_ID,
  );
}

export async function activateConfiguredTopUpOffer(stripe: Stripe) {
  return await activateConfiguredOffer(
    stripe,
    "top_up",
    process.env.STRIPE_CREDIT_PRICE_ID,
  );
}

export function isProSubscriptionForOffer(
  subscription: Stripe.Subscription,
  offer: Pick<
    BillingOfferRecord,
    | "id"
    | "kind"
    | "stripePriceId"
    | "stripeProductId"
    | "unitAmount"
    | "currency"
    | "recurringInterval"
    | "recurringIntervalCount"
  >,
): boolean {
  if (offer.kind !== "pro" || subscription.items.data.length !== 1) {
    return false;
  }
  const item = subscription.items.data[0];
  const metadataOfferId = subscription.metadata?.billingOfferId;
  return (
    (!metadataOfferId || metadataOfferId === offer.id) &&
    item.price.id === offer.stripePriceId &&
    getExpandableId(item.price.product) === offer.stripeProductId &&
    item.price.unit_amount === offer.unitAmount &&
    item.price.currency.toLowerCase() === offer.currency.toLowerCase() &&
    item.quantity === 1 &&
    item.price.recurring?.interval === offer.recurringInterval &&
    item.price.recurring.interval_count === offer.recurringIntervalCount
  );
}

export async function resolvePersistedProBillingOffer(
  subscription: Stripe.Subscription,
): Promise<BillingOfferRecord | null> {
  if (
    subscription.items.data.length !== 1 ||
    subscription.metadata?.planId !== PRO_PLAN.id
  ) {
    return null;
  }
  const item = subscription.items.data[0];
  const stripePriceId = item.price.id;
  const historicalProductId = historicalProOffers().get(stripePriceId);
  if (
    stripePriceId !== process.env.STRIPE_PRO_PRICE_ID &&
    (!historicalProductId ||
      getExpandableId(item.price.product) !== historicalProductId)
  ) {
    return null;
  }
  const offer = await findBillingOfferByStripePriceId({ stripePriceId });
  if (!offer || offer.kind !== "pro") {
    return null;
  }
  const billingOffer = offer as BillingOfferRecord;
  if (!isProSubscriptionForOffer(subscription, billingOffer)) {
    return null;
  }
  return billingOffer;
}

// This is the only path that may learn an offer from an existing Stripe
// subscription. Callers must first prove that the subscription belongs to the
// mapped Beutl user. Historical Prices are persisted disabled even when Stripe
// still reports them active, so discovery can never expose them to Checkout.
export async function resolveProBillingOffer(
  stripe: Stripe,
  subscription: Stripe.Subscription,
  proof: { ownershipVerified: true },
): Promise<BillingOfferRecord | null> {
  if (proof.ownershipVerified !== true) {
    throw new Error("Stripe subscription ownership must be verified");
  }
  if (
    subscription.items.data.length !== 1 ||
    subscription.metadata?.planId !== PRO_PLAN.id
  ) {
    return null;
  }

  const stripePriceId = subscription.items.data[0].price.id;
  const currentPriceId = process.env.STRIPE_PRO_PRICE_ID;
  const historicalProductId = historicalProOffers().get(stripePriceId);
  if (stripePriceId !== currentPriceId && !historicalProductId) {
    return null;
  }
  const persisted = await resolvePersistedProBillingOffer(subscription);
  if (
    persisted &&
    (stripePriceId === currentPriceId ||
      persisted.stripeProductId === historicalProductId)
  ) {
    return persisted;
  }
  const price = await stripe.prices.retrieve(stripePriceId);
  if (
    stripePriceId === currentPriceId
      ? !price.active
      : getExpandableId(price.product) !== historicalProductId
  ) {
    return null;
  }
  const offer = stripePriceId === currentPriceId
    ? await activateBillingOffer({
        terms: termsFromPrice(price, "pro", true),
      })
    : await registerHistoricalBillingOffer({
        terms: termsFromPrice(price, "pro", false),
        ownershipVerified: proof.ownershipVerified,
      });
  const billingOffer = offer as BillingOfferRecord;
  return isProSubscriptionForOffer(subscription, billingOffer)
    ? billingOffer
    : null;
}

export function blocksNewProCheckout(
  subscription: Stripe.Subscription,
  recognizedProPriceIds: ReadonlySet<string>,
): boolean {
  const item = subscription.items.data[0];
  return (
    subscription.items.data.length === 1 &&
    item.quantity === 1 &&
    recognizedProPriceIds.has(item.price.id) &&
    item.price.recurring?.interval === "month" &&
    item.price.recurring.interval_count === 1 &&
    subscription.status !== "canceled" &&
    subscription.status !== "incomplete_expired"
  );
}

export function topUpPaymentMatchesOffer(
  paymentIntent: Stripe.PaymentIntent,
  offer: BillingOfferRecord,
): boolean {
  return (
    offer.kind === "top_up" &&
    paymentIntent.metadata?.billingOfferId === offer.id &&
    paymentIntent.amount_received === offer.unitAmount &&
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
