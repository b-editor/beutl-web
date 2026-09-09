import { addAuditLog, auditLogActions } from "@beutl/next/audit-log";
import {
  getScheduledCancellationTime,
  isCancellationScheduled,
} from "@/lib/stripe/cancellation";
import {
  fulfillOrRefundTopUpPayment,
  getSubscriptionPeriod,
  resolveTopUpPayment,
} from "@/lib/stripe/ai-billing";
import {
  resolvePersistedSubscriptionOffer,
  resolveSubscriptionOffer,
  subscriptionPlanFromStripe,
  type SubscriptionOfferRecord,
} from "@/lib/stripe/subscription-billing";
import {
  subscriptionPlanConfig,
  type SubscriptionPlanConfig,
} from "@/lib/stripe/subscription-plans";
import { createStripe } from "@/lib/stripe/config";
import { isStripeResourceMissingError } from "@/lib/stripe/errors";
import { resolveInvoiceServicePeriod } from "@/lib/stripe/invoice-period";
import {
  refundPackagePayment,
  resolvePackagePayment,
  resolvePackagePaymentOwner,
} from "@/lib/stripe/package-payment";
import {
  getCanonicalPaymentRefundState,
  observeBillingRefundForPaymentIntent,
} from "@beutl/api";
import {
  deleteSubscriptionCheckoutAttempt,
  findCreditPurchaseByStripePaymentId,
  findCustomerByStripeId,
  findPackagePaymentReference,
  getSubscription,
  listSubscriptionsByUserId,
  PACKAGE_PAYMENT_EVENT_RANK,
  reconcilePurchasedCreditReversal,
  reconcileSubscriptionEntitlementHold,
  reconcileSubscriptionObservation,
  recordTopUpRefund,
  recordPackagePaymentSucceeded,
  restorePackagePayment,
  revokePackagePayment,
  type PackagePaymentReference,
  type PackagePaymentStateResult,
} from "@beutl/db";
import { type NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import {
  ACTIVE_DISPUTE_STATUSES,
  compareSubscriptionRank,
  getInvoiceSubscription,
  isOwnedSubscription,
  isTerminalSubscriptionStatus,
  resolveCanonicalInvoiceReversalTotals,
  resolveOwnedSubscriptionInvoicePayment,
  resolveRefundCustomerId,
  retrieveSubscriptionForWebhookEvent,
  stripeEventCreatedAt,
  subscriptionCreatedAt,
  type OwnedSubscriptionInvoicePayment,
  type StripeClient,
  type StripeEventObservation,
} from "@/lib/stripe/subscription-webhook-shared";

// A stored subscription row, with or without the hold flag that
// getSubscription adds.
type StoredSubscription = Omit<
  NonNullable<Awaited<ReturnType<typeof getSubscription>>>,
  "entitlementHeld"
>;

// Which plan a Stripe subscription belongs to, from its metadata. A
// subscription that names no known plan is examined as AI Pro, which is how
// every subscription was read before plans existed; its offer then fails to
// resolve unless the metadata says "pro".
function planFor(
  subscription: Pick<Stripe.Subscription, "metadata">,
): SubscriptionPlanConfig {
  return subscriptionPlanFromStripe(subscription) ?? subscriptionPlanConfig("pro");
}

function getExpandableId(
  value: string | { id: string } | null | undefined,
): string | null {
  if (typeof value === "string") {
    return value;
  }
  return value?.id ?? null;
}

async function reconcileCanonicalRefund(
  stripe: StripeClient,
  eventRefund: Stripe.Refund,
  event: StripeEventObservation,
): Promise<boolean> {
  const refund = await stripe.refunds.retrieve(eventRefund.id);
  const paymentIntentId = getExpandableId(refund.payment_intent);
  if (!paymentIntentId) {
    return false;
  }

  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  const [purchase, resolution] = await Promise.all([
    findCreditPurchaseByStripePaymentId({
      stripePaymentId: paymentIntent.id,
    }),
    resolveTopUpPayment(paymentIntent),
  ]);
  if (!purchase && !resolution) return false;
  if (
    purchase &&
    ((purchase.stripePaymentAmount != null &&
      purchase.stripePaymentAmount !== paymentIntent.amount_received) ||
      (purchase.stripeCurrency != null &&
        purchase.stripeCurrency !== paymentIntent.currency.toLowerCase()))
  ) {
    throw new Error(
      `AI top-up ${paymentIntent.id} conflicts with its persisted purchase`,
    );
  }
  if (resolution?.status === "invalid" && !purchase) return true;

  const canonicalRefundState = await getCanonicalPaymentRefundState({
    stripe,
    stripePaymentIntentId: paymentIntentId,
  });
  const canonicalPaymentIntent = canonicalRefundState.paymentIntent;

  const status = refund.status ?? "unknown";
  await reconcilePurchasedCreditReversal({
    stripePaymentId: canonicalPaymentIntent.id,
    stripePayment: {
      amount: canonicalPaymentIntent.amount_received,
      currency: canonicalPaymentIntent.currency,
    },
    reversalKind: "refund",
    reversalId: refund.id,
    reversalAmount: refund.amount,
    reversalCurrency: refund.currency,
    status,
    // Reserve the value as soon as a refund exists. Explicit failed/canceled
    // states restore it after Stripe confirms that funds were not returned.
    active: status !== "failed" && status !== "canceled",
    stripeEventId: event.id,
    stripeEventCreatedAt: stripeEventCreatedAt(event),
  });
  if (resolution?.attempt) {
    await recordTopUpRefund({
      attemptId: resolution.attempt.id,
      stripePaymentIntentId: canonicalPaymentIntent.id,
      refundId: refund.id,
      refundStatus: status,
      refundTargetAmount: canonicalRefundState.targetAmount,
      refundSucceededAmount: canonicalRefundState.succeededAmount,
      refundPendingAmount: canonicalRefundState.pendingAmount,
      refundCurrency: canonicalRefundState.currency,
    });
  }
  return true;
}

async function reconcileDurableBillingRefund(
  stripe: StripeClient,
  eventRefund: Stripe.Refund,
): Promise<boolean> {
  const refund = await stripe.refunds.retrieve(eventRefund.id);
  const stripePaymentIntentId = getExpandableId(refund.payment_intent);
  if (!stripePaymentIntentId) return false;
  return await observeBillingRefundForPaymentIntent({
    stripe,
    stripePaymentIntentId,
    observedAt: new Date(),
  });
}

async function reconcileCanonicalDispute(
  stripe: StripeClient,
  eventDispute: Stripe.Dispute,
  event: StripeEventObservation,
): Promise<boolean> {
  const dispute = await stripe.disputes.retrieve(eventDispute.id);
  const paymentIntentId = getExpandableId(dispute.payment_intent);
  if (!paymentIntentId) {
    return false;
  }

  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  const [purchase, resolution] = await Promise.all([
    findCreditPurchaseByStripePaymentId({
      stripePaymentId: paymentIntent.id,
    }),
    resolveTopUpPayment(paymentIntent),
  ]);
  if (!purchase && !resolution) return false;
  if (
    purchase &&
    ((purchase.stripePaymentAmount != null &&
      purchase.stripePaymentAmount !== paymentIntent.amount_received) ||
      (purchase.stripeCurrency != null &&
        purchase.stripeCurrency !== paymentIntent.currency.toLowerCase()))
  ) {
    throw new Error(
      `AI top-up ${paymentIntent.id} conflicts with its persisted purchase`,
    );
  }
  if (resolution?.status === "invalid" && !purchase) return true;

  await reconcilePurchasedCreditReversal({
    stripePaymentId: paymentIntent.id,
    stripePayment: {
      amount: paymentIntent.amount_received,
      currency: paymentIntent.currency,
    },
    reversalKind: "dispute",
    reversalId: dispute.id,
    reversalAmount: dispute.amount,
    reversalCurrency: dispute.currency,
    status: dispute.status,
    active: ACTIVE_DISPUTE_STATUSES.has(dispute.status),
    stripeEventId: event.id,
    stripeEventCreatedAt: stripeEventCreatedAt(event),
  });
  return true;
}

async function resolveCanonicalSubscription(
  stripe: ReturnType<typeof createStripe>,
  plan: SubscriptionPlanConfig,
  incoming: Stripe.Subscription,
  userId: string,
  incomingObservedAt: Date,
): Promise<{
  subscription: Stripe.Subscription;
  canonicalObservedAt: Date;
  billingOffer: SubscriptionOfferRecord | null;
}> {
  const stored = await getSubscription({ userId, planId: plan.id });
  if (!stored || stored.stripeSubscriptionId === incoming.id) {
    return {
      subscription: incoming,
      canonicalObservedAt: incomingObservedAt,
      billingOffer: await resolvePersistedSubscriptionOffer(plan, incoming),
    };
  }

  try {
    const storedSubscription = await stripe.subscriptions.retrieve(
      stored.stripeSubscriptionId,
    );
    const [storedOffer, incomingOffer] = await Promise.all([
      resolvePersistedSubscriptionOffer(plan, storedSubscription),
      resolvePersistedSubscriptionOffer(plan, incoming),
    ]);
    const chooseStored =
      compareSubscriptionRank(
        storedSubscription,
        incoming,
        storedOffer !== null,
        incomingOffer !== null,
      ) >= 0;
    return {
      subscription: chooseStored ? storedSubscription : incoming,
      canonicalObservedAt: new Date(),
      billingOffer: chooseStored ? storedOffer : incomingOffer,
    };
  } catch (error) {
    if (isStripeResourceMissingError(error)) {
      console.warn("Stored Stripe subscription no longer exists", {
        userId,
        stripeSubscriptionId: stored.stripeSubscriptionId,
      });
      return {
        subscription: incoming,
        canonicalObservedAt: new Date(),
        billingOffer: await resolvePersistedSubscriptionOffer(plan, incoming),
      };
    }
    throw error;
  }
}

async function persistSubscriptionObservation({
  plan,
  subscription,
  userId,
  event,
  canonicalObservedAt,
  billingOfferId,
  tier,
  status = subscription.status,
  replaceExistingSubscription = true,
}: {
  plan: SubscriptionPlanConfig;
  subscription: Stripe.Subscription;
  userId: string;
  event: StripeEventObservation;
  canonicalObservedAt: Date;
  billingOfferId: string | null;
  tier: string | null;
  status?: string;
  replaceExistingSubscription?: boolean;
}): Promise<void> {
  const period = getSubscriptionPeriod(subscription);
  await reconcileSubscriptionObservation({
    userId,
    stripeSubscriptionId: subscription.id,
    status,
    planId: plan.id,
    tier,
    billingOfferId,
    ...period,
    // A portal cancellation keeps the subscription active until the period ends.
    // Depending on the API version Stripe records it in `cancel_at_period_end`
    // or only in `cancel_at`, so both have to be considered.
    cancelAtPeriodEnd: isCancellationScheduled(subscription),
    cancelAt: getScheduledCancellationTime(subscription),
    stripeSubscriptionCreatedAt: subscriptionCreatedAt(subscription),
    stripeEventId: event.id,
    stripeEventCreatedAt: stripeEventCreatedAt(event),
    stripeCanonicalObservedAt: canonicalObservedAt,
    replaceExistingSubscription,
  });
}

// A resource_missing response is Stripe's definitive statement that this
// subscription no longer exists. Keep the original subscription id and event
// watermark so a later webhook for a different subscription can still replace
// this terminal row.
async function persistMissingSubscriptionObservation({
  stored,
  userId,
  event,
}: {
  stored: StoredSubscription;
  userId: string;
  event: StripeEventObservation;
}): Promise<void> {
  await reconcileSubscriptionObservation({
    userId,
    stripeSubscriptionId: stored.stripeSubscriptionId,
    status: "canceled",
    planId: stored.planId,
    tier: stored.tier,
    billingOfferId: stored.billingOfferId,
    currentPeriodStart: stored.currentPeriodStart,
    currentPeriodEnd: stored.currentPeriodEnd,
    cancelAtPeriodEnd: false,
    cancelAt: null,
    stripeSubscriptionCreatedAt: null,
    stripeEventId: event.id,
    stripeEventCreatedAt: stripeEventCreatedAt(event),
    stripeCanonicalObservedAt: new Date(),
    replaceExistingSubscription: false,
  });
}

// Subscription events can arrive long after a newer Checkout attempt has been
// bound for the same user. Resolve the event's own subscription back to Stripe
// Checkout Sessions and delete only an exactly matching completed binding.
async function deleteSubscriptionCheckoutAttemptsForSubscription({
  stripe,
  userId,
  stripeSubscriptionId,
}: {
  stripe: StripeClient;
  userId: string;
  stripeSubscriptionId: string;
}): Promise<void> {
  let startingAfter: string | undefined;
  for (;;) {
    const sessions = await stripe.checkout.sessions.list({
      subscription: stripeSubscriptionId,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    await Promise.all(
      sessions.data.map(async (checkoutSession) => {
        if (
          checkoutSession.status !== "complete" ||
          getExpandableId(checkoutSession.subscription) !==
            stripeSubscriptionId
        ) {
          return;
        }
        await deleteSubscriptionCheckoutAttempt({
          userId,
          stripeCheckoutSessionId: checkoutSession.id,
        });
      }),
    );
    if (!sessions.has_more) {
      return;
    }
    const lastSession = sessions.data.at(-1);
    if (!lastSession) {
      throw new Error(
        "Stripe returned an empty Checkout Session page with has_more",
      );
    }
    startingAfter = lastSession.id;
  }
}

// The plan-specific half of a subscription invoice reversal: which offer the
// invoice was for, its service period, and how much of the payment is reversed.
async function resolveSubscriptionPayment(
  stripe: StripeClient,
  stripePaymentIntentId: string,
  event: Stripe.Event,
  owned: OwnedSubscriptionInvoicePayment,
) {
  const { invoice, subscription, customerId, customer } = owned;
  const plan = planFor(subscription);
  const billingOffer = await resolveSubscriptionOffer(plan, stripe, subscription, {
    ownershipVerified: true,
  });
  if (
    !billingOffer ||
    invoice.currency.toLowerCase() !== billingOffer.currency.toLowerCase()
  ) {
    return null;
  }

  // 明細行まで読む。初回請求書はトップレベルの period が同値になるため、ここで
  // トップレベルだけを見ていると初回の全額返金・チャージバックが「期間の取れない
  // 請求」として黙って捨てられ、利用権が残ってしまう。
  const servicePeriod = resolveInvoiceServicePeriod(invoice);
  if (!servicePeriod) return null;
  const invoicePeriodStart = servicePeriod.start;
  const invoicePeriodEnd = servicePeriod.end;
  const totals = await resolveCanonicalInvoiceReversalTotals({
    stripe,
    invoice,
    stripePaymentIntentId,
    customerId,
  });
  if (!totals) return null;

  const stored = await getSubscription({ userId: customer.userId, planId: plan.id });
  if (!stored || stored.stripeSubscriptionId === subscription.id) {
    await persistSubscriptionObservation({
      plan,
      subscription,
      userId: customer.userId,
      event,
      canonicalObservedAt: new Date(),
      billingOfferId: billingOffer.id,
      tier: billingOffer.tier,
      replaceExistingSubscription: stored === null,
    });
  }
  return {
    subscription,
    customer,
    billingOffer,
    stripeInvoiceId: invoice.id,
    billingPeriodStart: invoicePeriodStart,
    billingPeriodEnd: invoicePeriodEnd,
    ...totals,
  };
}

async function reconcileProEntitlementHold({
  stripe,
  stripePaymentIntentId,
  reversalKind,
  reversalId,
  reversalCurrency,
  status,
  event,
}: {
  stripe: StripeClient;
  stripePaymentIntentId: string;
  reversalKind: "refund" | "dispute";
  reversalId: string;
  reversalCurrency: string;
  status: string;
  event: Stripe.Event;
}): Promise<boolean> {
  const owned = await resolveOwnedSubscriptionInvoicePayment(
    stripe,
    stripePaymentIntentId,
  );
  if (!owned) return false;
  const context = await resolveSubscriptionPayment(
    stripe,
    stripePaymentIntentId,
    event,
    owned,
  );
  if (
    !context ||
    reversalCurrency.toLowerCase() !== context.currency
  ) {
    return false;
  }
  await reconcileSubscriptionEntitlementHold({
    userId: context.customer.userId,
    stripeSubscriptionId: context.subscription.id,
    stripePaymentIntentId,
    stripeReversalKind: reversalKind,
    stripeReversalId: reversalId,
    stripeInvoiceId: context.stripeInvoiceId,
    billingPeriodStart: context.billingPeriodStart,
    billingPeriodEnd: context.billingPeriodEnd,
    paymentAmount: context.paymentAmount,
    reversalAmount: context.reversalAmount,
    currency: context.currency,
    status,
    active: context.reversalAmount >= context.paymentAmount,
    stripeEventId: event.id,
    stripeEventCreatedAt: stripeEventCreatedAt(event),
    stripeCanonicalObservedAt: new Date(),
  });
  return true;
}

async function reconcileProRefund(
  stripe: StripeClient,
  eventRefund: Stripe.Refund,
  event: Stripe.Event,
): Promise<boolean> {
  const refund = await stripe.refunds.retrieve(eventRefund.id);
  const paymentIntentId = getExpandableId(refund.payment_intent);
  if (!paymentIntentId) return false;
  const status = refund.status ?? "unknown";
  return await reconcileProEntitlementHold({
    stripe,
    stripePaymentIntentId: paymentIntentId,
    reversalKind: "refund",
    reversalId: refund.id,
    reversalCurrency: refund.currency,
    status,
    event,
  });
}

async function reconcileProDispute(
  stripe: StripeClient,
  eventDispute: Stripe.Dispute,
  event: Stripe.Event,
): Promise<boolean> {
  const dispute = await stripe.disputes.retrieve(eventDispute.id);
  const paymentIntentId = getExpandableId(dispute.payment_intent);
  if (!paymentIntentId) return false;
  return await reconcileProEntitlementHold({
    stripe,
    stripePaymentIntentId: paymentIntentId,
    reversalKind: "dispute",
    reversalId: dispute.id,
    reversalCurrency: dispute.currency,
    status: dispute.status,
    event,
  });
}

const REVOKED_DISPUTE_STATUSES = new Set<Stripe.Dispute.Status>([
  "needs_response",
  "under_review",
  "lost",
]);

const RESTORED_DISPUTE_STATUSES = new Set<Stripe.Dispute.Status>([
  "prevented",
  "warning_closed",
  "won",
]);

const REFUND_INTERVENTION_STATUSES = new Set([
  "failed",
  "canceled",
  "requires_action",
]);
const PACKAGE_PAYMENT_VALIDATION_REFUND =
  "package-payment-validation-failed";

function stripeStateEvent(
  event: Stripe.Event,
  rank: number,
): { id: string; createdAt: Date; rank: number } {
  const createdAt = new Date(event.created * 1_000);
  if (!Number.isSafeInteger(event.created) || Number.isNaN(createdAt.getTime())) {
    throw new TypeError("Stripe event timestamp is invalid");
  }
  return { id: event.id, createdAt, rank };
}

async function addPaymentAuditLog(
  result: PackagePaymentStateResult | null,
  action: string,
  details: string,
): Promise<void> {
  if (!result?.changed) {
    return;
  }
  try {
    await addAuditLog({
      userId: result.userId,
      action,
      details: `packageId: ${result.packageId}, paymentIntentId: ${result.paymentId}, ${details}`,
    });
  } catch (error) {
    console.error("Failed to record package-payment audit log", error);
  }
}

async function resolveReversalReference({
  paymentIntent,
  stripe,
  requireValidPayment,
  event,
}: {
  paymentIntent: Stripe.PaymentIntent;
  stripe: StripeClient;
  requireValidPayment: boolean;
  event: Stripe.Event;
}): Promise<PackagePaymentReference | null> {
  const existing = await findPackagePaymentReference({
    paymentId: paymentIntent.id,
  });
  if (existing && (!requireValidPayment || existing.fulfillmentValidated)) {
    return existing;
  }

  if (requireValidPayment) {
    const payment = await resolvePackagePayment({ paymentIntent, stripe });
    if (payment.status !== "fulfill") {
      return null;
    }
    const result = await recordPackagePaymentSucceeded({
      reference: payment.reference,
      billing: {
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
      },
      event: stripeStateEvent(
        event,
        PACKAGE_PAYMENT_EVENT_RANK.paymentSucceeded,
      ),
    });
    return result ? payment.reference : null;
  }
  const owner = await resolvePackagePaymentOwner({ paymentIntent, stripe });
  return owner.status === "owned" ? owner.reference : null;
}

async function handlePaymentSucceeded(
  stripe: StripeClient,
  paymentIntent: Stripe.PaymentIntent,
  event: Stripe.Event,
): Promise<void> {
  const existing = await findPackagePaymentReference({
    paymentId: paymentIntent.id,
  });
  if (existing?.fulfillmentValidated) {
    return;
  }
  const payment = await resolvePackagePayment({ paymentIntent, stripe });
  if (payment.status === "unrecognized") {
    return;
  }
  if (payment.status === "refund") {
    await refundPackagePayment({
      paymentIntentId: paymentIntent.id,
      reason: payment.reason,
      stripe,
    });
    return;
  }

  const result = await recordPackagePaymentSucceeded({
    reference: payment.reference,
    billing: {
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
    },
    event: stripeStateEvent(
      event,
      PACKAGE_PAYMENT_EVENT_RANK.paymentSucceeded,
    ),
  });
  if (!result) {
    await refundPackagePayment({
      paymentIntentId: paymentIntent.id,
      reason: "package price changed before fulfillment",
      stripe,
    });
    return;
  }
  await addPaymentAuditLog(
    result,
    auditLogActions.store.paymentSucceeded,
    "state: active",
  );
}

async function handleRefundedCharge(
  stripe: StripeClient,
  eventCharge: Stripe.Charge,
  event: Stripe.Event,
): Promise<void> {
  const charge = await stripe.charges.retrieve(eventCharge.id);
  if (charge.amount_refunded <= 0) {
    return;
  }
  const refund = await findSucceededRefund(stripe, charge.id);
  if (!refund) {
    return;
  }
  const paymentIntentId = getExpandableId(charge.payment_intent);
  if (!paymentIntentId) {
    return;
  }
  if (await reconcileCanonicalRefund(stripe, refund, event)) {
    return;
  }
  if (await reconcileProRefund(stripe, refund, event)) {
    return;
  }
  await revokeRefundedPayment({
    stripe,
    event,
    paymentIntentId,
    chargeId: charge.id,
    refundId: refund.id,
  });
}

// A refund is often issued together with canceling the subscription in Stripe.
// The subscription lifecycle events carry that state, but when one is missed the
// stored row keeps its last non-terminal status and the user cannot resubscribe
// until the stored period elapses. Re-read the canonical subscription here and
// persist a terminal status so the local row cannot stay stale.
async function reconcileSubscriptionAfterReversal(
  stripe: StripeClient,
  customerId: string | null,
  event: Stripe.Event,
): Promise<void> {
  if (!customerId) {
    return;
  }
  const customer = await findCustomerByStripeId({ stripeId: customerId });
  if (!customer) {
    return;
  }
  // Every plan's subscription lives on the same customer; a refund of any
  // invoice re-reads each stored row that still claims to be live.
  for (const stored of await listSubscriptionsByUserId({ userId: customer.userId })) {
    if (isTerminalSubscriptionStatus(stored.status)) {
      continue;
    }

    let subscription: Stripe.Subscription;
    try {
      subscription = await stripe.subscriptions.retrieve(
        stored.stripeSubscriptionId,
      );
    } catch (error) {
      if (isStripeResourceMissingError(error)) {
        await persistMissingSubscriptionObservation({
          stored,
          userId: customer.userId,
          event,
        });
        await deleteSubscriptionCheckoutAttemptsForSubscription({
          stripe,
          userId: customer.userId,
          stripeSubscriptionId: stored.stripeSubscriptionId,
        });
        continue;
      }
      throw error;
    }

    if (!isTerminalSubscriptionStatus(subscription.status)) {
      continue;
    }
    if (
      !isOwnedSubscription(
        subscription,
        customerId,
        customer.userId,
        customer.ownership,
      )
    ) {
      console.warn("Ignoring an unowned subscription during reversal reconciliation", {
        stripeSubscriptionId: subscription.id,
        userId: customer.userId,
      });
      continue;
    }

    await persistSubscriptionObservation({
      plan: subscriptionPlanConfig(
        subscriptionPlanFromStripe(subscription)?.id ??
          (stored.planId === "storage" ? "storage" : "pro"),
      ),
      subscription,
      userId: customer.userId,
      event,
      canonicalObservedAt: new Date(),
      billingOfferId: stored.billingOfferId,
      tier: stored.tier,
      status: subscription.status,
      replaceExistingSubscription: false,
    });
    await deleteSubscriptionCheckoutAttemptsForSubscription({
      stripe,
      userId: customer.userId,
      stripeSubscriptionId: subscription.id,
    });
  }
}

async function findSucceededRefund(
  stripe: StripeClient,
  chargeId: string,
): Promise<Stripe.Refund | null> {
  let startingAfter: string | undefined;
  while (true) {
    const refunds = await stripe.refunds.list({
      charge: chargeId,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    const succeeded = refunds.data.find(
      (refund) => refund.status === "succeeded",
    );
    if (succeeded) {
      return succeeded;
    }
    if (!refunds.has_more) {
      return null;
    }
    const lastRefund = refunds.data.at(-1);
    if (!lastRefund) {
      throw new Error("Stripe returned an empty refund page with has_more");
    }
    startingAfter = lastRefund.id;
  }
}

async function handleRefund(
  stripe: StripeClient,
  eventRefund: Stripe.Refund,
  event: Stripe.Event,
): Promise<void> {
  const refund = await stripe.refunds.retrieve(eventRefund.id);
  if (refund.status !== "succeeded") {
    await recordAutomaticRefundFailure(refund);
    return;
  }
  let paymentIntentId = getExpandableId(refund.payment_intent);
  const chargeId = getExpandableId(refund.charge);
  if (!paymentIntentId && chargeId) {
    const charge = await stripe.charges.retrieve(chargeId);
    paymentIntentId = getExpandableId(charge.payment_intent);
  }
  if (!paymentIntentId) {
    return;
  }
  await revokeRefundedPayment({
    stripe,
    event,
    paymentIntentId,
    chargeId,
    refundId: refund.id,
  });
}

async function recordAutomaticRefundFailure(
  refund: Stripe.Refund,
): Promise<void> {
  if (
    !refund.status ||
    !REFUND_INTERVENTION_STATUSES.has(refund.status) ||
    refund.metadata?.beutlDisposition !== PACKAGE_PAYMENT_VALIDATION_REFUND
  ) {
    return;
  }
  await addAuditLog({
    userId: null,
    action:
      refund.status === "requires_action"
        ? auditLogActions.store.paymentRefundRequiresAction
        : auditLogActions.store.paymentRefundFailed,
    details: [
      `refundId: ${refund.id}`,
      `refundStatus: ${refund.status}`,
      `paymentIntentId: ${getExpandableId(refund.payment_intent) ?? "unknown"}`,
      `chargeId: ${getExpandableId(refund.charge) ?? "unknown"}`,
      `failureReason: ${refund.failure_reason ?? "unknown"}`,
      `dispositionReason: ${refund.metadata.beutlDispositionReason ?? "unknown"}`,
    ].join(", "),
  });
}

async function revokeRefundedPayment({
  stripe,
  event,
  paymentIntentId,
  chargeId,
  refundId,
}: {
  stripe: StripeClient;
  event: Stripe.Event;
  paymentIntentId: string;
  chargeId: string | null;
  refundId: string;
}): Promise<void> {
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  const reference = await resolveReversalReference({
    paymentIntent,
    stripe,
    requireValidPayment: false,
    event,
  });
  const result = await revokePackagePayment({
    paymentId: paymentIntent.id,
    reference: reference
      ? { userId: reference.userId, packageId: reference.packageId }
      : undefined,
    event: stripeStateEvent(
      event,
      PACKAGE_PAYMENT_EVENT_RANK.refundSucceeded,
    ),
    reason: `refund succeeded: ${refundId}`,
  });
  await addPaymentAuditLog(
    result,
    auditLogActions.store.paymentRevoked,
    `state: revoked, chargeId: ${chargeId ?? "unknown"}, refundId: ${refundId}`,
  );
}

async function handleDispute(
  stripe: StripeClient,
  eventDispute: Stripe.Dispute,
  event: Stripe.Event,
): Promise<void> {
  const dispute = await stripe.disputes.retrieve(eventDispute.id);
  const paymentIntentId = getExpandableId(dispute.payment_intent);
  if (!paymentIntentId) {
    return;
  }
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  const shouldRevoke = REVOKED_DISPUTE_STATUSES.has(dispute.status);
  const shouldRestore = RESTORED_DISPUTE_STATUSES.has(dispute.status);
  if (!shouldRevoke && !shouldRestore) {
    return;
  }
  if (shouldRestore) {
    const chargeId = getExpandableId(dispute.charge);
    if (chargeId) {
      const charge = await stripe.charges.retrieve(chargeId);
      if (
        charge.amount_refunded > 0 &&
        (await findSucceededRefund(stripe, charge.id))
      ) {
        return;
      }
    }
  }
  const reference = await resolveReversalReference({
    paymentIntent,
    stripe,
    requireValidPayment: !shouldRevoke,
    event,
  });

  if (shouldRevoke) {
    const result = await revokePackagePayment({
      paymentId: paymentIntent.id,
      reference: reference
        ? { userId: reference.userId, packageId: reference.packageId }
        : undefined,
      event: stripeStateEvent(
        event,
        PACKAGE_PAYMENT_EVENT_RANK.disputeRevoked,
      ),
      reason: `dispute ${dispute.status}: ${dispute.id}`,
    });
    await addPaymentAuditLog(
      result,
      auditLogActions.store.paymentRevoked,
      `state: revoked, disputeId: ${dispute.id}, disputeStatus: ${dispute.status}`,
    );
    return;
  }

  if (!reference) {
    return;
  }
  const result = await restorePackagePayment({
    paymentId: paymentIntent.id,
    reference: { userId: reference.userId, packageId: reference.packageId },
    event: stripeStateEvent(
      event,
      PACKAGE_PAYMENT_EVENT_RANK.disputeRestored,
    ),
  });
  await addPaymentAuditLog(
    result,
    auditLogActions.store.paymentRestored,
    `state: active, disputeId: ${dispute.id}, disputeStatus: ${dispute.status}`,
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const stripe = createStripe();
  const sig = request.headers.get("stripe-signature");
  if (!sig) {
    return NextResponse.json({ message: "No signature" }, { status: 400 });
  }

  const body = await request.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      body,
      sig,
      process.env.STRIPE_ENDPOINT_SECRET as string,
    );
  } catch (err) {
    console.error("Stripe webhook signature verification failed", err);
    return NextResponse.json({ message: "Invalid signature" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const eventSubscription = event.data.object as Stripe.Subscription;
        // Subscription events can arrive out of order. Always retrieve the
        // latest object instead of persisting this event's stale snapshot.
        const retrievedSubscription = await retrieveSubscriptionForWebhookEvent(
          stripe,
          eventSubscription.id,
          event,
        );
        if (!retrievedSubscription) {
          break;
        }
        const retrievedObservedAt = new Date();
        if (typeof retrievedSubscription.customer !== "string") {
          return NextResponse.json(
            { message: "subscription.customer is not string" },
            { status: 400 },
          );
        }
        const customer = await findCustomerByStripeId({
          stripeId: retrievedSubscription.customer,
        });
        if (!customer) {
          // Customer mappings are created before Checkout begins. A missing
          // mapping here therefore represents an already-deleted account (or
          // an event outside Beutl's ownership), neither of which Stripe
          // should retry indefinitely.
          console.warn("Acknowledging a Stripe subscription event for a missing customer mapping", {
            eventId: event.id,
            eventType: event.type,
            stripeCustomerId: retrievedSubscription.customer,
            stripeSubscriptionId: retrievedSubscription.id,
          });
          break;
        }
        const plan = planFor(retrievedSubscription);
        const { subscription, canonicalObservedAt, billingOffer } =
          await resolveCanonicalSubscription(
            stripe,
            plan,
            retrievedSubscription,
            customer.userId,
            retrievedObservedAt,
          );
        if (
          !isOwnedSubscription(
            subscription,
            retrievedSubscription.customer,
            customer.userId,
            customer.ownership,
          )
        ) {
          console.warn("Ignoring an unowned Stripe subscription", {
            stripeSubscriptionId: subscription.id,
            userId: customer.userId,
          });
          break;
        }
        const ownedBillingOffer =
          billingOffer ??
          (await resolveSubscriptionOffer(plan, stripe, subscription, {
            ownershipVerified: true,
          }));
        if (!ownedBillingOffer) {
          const storedSubscription = await getSubscription({
            userId: customer.userId,
            planId: plan.id,
          });
          if (storedSubscription?.stripeSubscriptionId === subscription.id) {
            await persistSubscriptionObservation({
              plan,
              subscription,
              userId: customer.userId,
              event,
              canonicalObservedAt,
              billingOfferId: storedSubscription.billingOfferId,
              tier: storedSubscription.tier,
              status: "invalid_price",
              replaceExistingSubscription: false,
            });
          }
          break;
        }
        await persistSubscriptionObservation({
          plan,
          subscription,
          userId: customer.userId,
          event,
          canonicalObservedAt,
          billingOfferId: ownedBillingOffer.id,
          tier: ownedBillingOffer.tier,
        });
        await deleteSubscriptionCheckoutAttemptsForSubscription({
          stripe,
          userId: customer.userId,
          stripeSubscriptionId: retrievedSubscription.id,
        });
        break;
      }
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        if (typeof subscription.customer !== "string") {
          return NextResponse.json(
            { message: "subscription.customer is not string" },
            { status: 400 },
          );
        }
        const customer = await findCustomerByStripeId({
          stripeId: subscription.customer,
        });
        if (!customer) {
          // Account deletion removes the local mapping after Stripe has
          // canceled the subscription. A delayed deletion event is therefore
          // already reconciled and must not be retried indefinitely.
          break;
        }
        if (
          !isOwnedSubscription(
            subscription,
            subscription.customer,
            customer.userId,
            customer.ownership,
          )
        ) {
          console.warn("Ignoring an unowned deleted Stripe subscription", {
            stripeSubscriptionId: subscription.id,
            userId: customer.userId,
          });
          break;
        }
        const plan = planFor(subscription);
        const storedSubscription = await getSubscription({
          userId: customer.userId,
          planId: plan.id,
        });
        if (storedSubscription?.stripeSubscriptionId !== subscription.id) {
          break;
        }
        await persistSubscriptionObservation({
          plan,
          subscription,
          userId: customer.userId,
          event,
          canonicalObservedAt: new Date(),
          billingOfferId: storedSubscription.billingOfferId,
          tier: storedSubscription.tier,
          status: "canceled",
          replaceExistingSubscription: false,
        });
        await deleteSubscriptionCheckoutAttemptsForSubscription({
          stripe,
          userId: customer.userId,
          stripeSubscriptionId: subscription.id,
        });
        break;
      }
      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        const invoiceSubscription = getInvoiceSubscription(invoice);
        if (!invoiceSubscription) {
          break;
        }
        const subscriptionId =
          typeof invoiceSubscription === "string"
            ? invoiceSubscription
            : invoiceSubscription.id;
        const retrievedSubscription = await retrieveSubscriptionForWebhookEvent(
          stripe,
          subscriptionId,
          event,
        );
        if (!retrievedSubscription) {
          break;
        }
        const retrievedObservedAt = new Date();
        if (typeof retrievedSubscription.customer !== "string") {
          return NextResponse.json(
            { message: "subscription.customer is not string" },
            { status: 400 },
          );
        }
        const customer = await findCustomerByStripeId({
          stripeId: retrievedSubscription.customer,
        });
        if (!customer) {
          console.warn("Acknowledging a Stripe invoice event for a missing customer mapping", {
            eventId: event.id,
            eventType: event.type,
            stripeCustomerId: retrievedSubscription.customer,
            stripeSubscriptionId: retrievedSubscription.id,
          });
          break;
        }
        const plan = planFor(retrievedSubscription);
        const { subscription, canonicalObservedAt, billingOffer } =
          await resolveCanonicalSubscription(
            stripe,
            plan,
            retrievedSubscription,
            customer.userId,
            retrievedObservedAt,
          );

        if (
          !isOwnedSubscription(
            subscription,
            retrievedSubscription.customer,
            customer.userId,
            customer.ownership,
          )
        ) {
          console.warn("Ignoring an unowned invoice subscription", {
            stripeSubscriptionId: subscription.id,
            userId: customer.userId,
          });
          break;
        }

        // A paid renewal advances the Stripe billing period. The included
        // allowance resets lazily when this period changes; no credits are granted.
        const ownedBillingOffer =
          billingOffer ??
          (await resolveSubscriptionOffer(plan, stripe, subscription, {
            ownershipVerified: true,
          }));
        if (!ownedBillingOffer) {
          break;
        }
        await persistSubscriptionObservation({
          plan,
          subscription,
          userId: customer.userId,
          event,
          canonicalObservedAt,
          billingOfferId: ownedBillingOffer.id,
          tier: ownedBillingOffer.tier,
        });
        await deleteSubscriptionCheckoutAttemptsForSubscription({
          stripe,
          userId: customer.userId,
          stripeSubscriptionId: retrievedSubscription.id,
        });
        break;
      }
      case "charge.refunded":
        await handleRefundedCharge(
          stripe,
          event.data.object as Stripe.Charge,
          event,
        );
        await reconcileSubscriptionAfterReversal(
          stripe,
          getExpandableId((event.data.object as Stripe.Charge).customer),
          event,
        );
        break;
      case "refund.created":
      case "refund.updated":
      case "refund.failed": {
        const refund = event.data.object as Stripe.Refund;
        const handledAsAiTopUp = await reconcileCanonicalRefund(
          stripe,
          refund,
          event,
        );
        const handledAsDurableBillingRefund =
          !handledAsAiTopUp &&
          (await reconcileDurableBillingRefund(stripe, refund));
        const handledAsPro =
          !handledAsAiTopUp && (await reconcileProRefund(stripe, refund, event));
        if (
          !handledAsAiTopUp &&
          !handledAsDurableBillingRefund &&
          !handledAsPro
        ) {
          await handleRefund(stripe, refund, event);
        }
        await reconcileSubscriptionAfterReversal(
          stripe,
          await resolveRefundCustomerId(stripe, refund),
          event,
        );
        break;
      }
      case "charge.dispute.created":
      case "charge.dispute.updated":
      case "charge.dispute.closed":
      case "charge.dispute.funds_withdrawn":
      case "charge.dispute.funds_reinstated": {
        const dispute = event.data.object as Stripe.Dispute;
        const handledAsAiTopUp = await reconcileCanonicalDispute(
          stripe,
          dispute,
          event,
        );
        const handledAsPro =
          !handledAsAiTopUp &&
          (await reconcileProDispute(stripe, dispute, event));
        if (!handledAsAiTopUp && !handledAsPro) {
          await handleDispute(stripe, dispute, event);
        }
        break;
      }
      case "payment_intent.succeeded": {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;

        if (paymentIntent.metadata?.creditAmount) {
          const result = await fulfillOrRefundTopUpPayment(stripe, paymentIntent);
          if (result.status === "fulfilled") {
            await addAuditLog({
              userId: result.userId,
              action: "ai.creditPurchase",
              details: `paymentIntentId: ${paymentIntent.id}, amount: ${result.creditAmount}`,
            });
          }
          return NextResponse.json({ received: true });
        }

        await handlePaymentSucceeded(stripe, paymentIntent, event);
        break;
      }
    }
  } catch (err) {
    console.error("Stripe webhook handler failed", err);
    return NextResponse.json({ message: "Internal error" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
