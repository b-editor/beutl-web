import {
  findBillingOfferById,
  findBoundSubscriptionCheckoutAttemptsForAccountDeletion,
  inspectAccountDeletionBillingBlockers,
  countActiveStripeCustomerProvisioning,
  findCustomerByUserId,
  findStripeCustomerOwnershipByStripeId,
  recordBillingRefundCancellation,
  scheduleBillingRefundAttempt,
  scheduleStripeCheckoutCleanup,
  setTopUpCheckoutSession,
  startRetryableTransaction,
} from "@beutl/db";
import {
  subscriptionPlanOf,
  type SubscriptionPlanDefinition,
} from "@beutl/core";
import { isStripeResourceMissingError } from "./errors";
import { createStripe } from "./config";
import { getExpandableId, hasStripeOwnerMetadata } from "./ownership";
import type Stripe from "stripe";
import { retrieveCustomerIfPresent, verifyCustomerOwnership } from "./customer";

type StripeClient = ReturnType<typeof createStripe>;

type CustomerClosureResult =
  | { status: "not-linked" }
  | { status: "already-closed"; customerId: string }
  | { status: "closed"; customerId: string }
  | { status: "owner-mismatch"; customerId: string };

function isTerminalSubscription(subscription: Stripe.Subscription): boolean {
  return (
    subscription.status === "canceled" ||
    subscription.status === "incomplete_expired"
  );
}

type PersistedBillingOffer = NonNullable<
  Awaited<ReturnType<typeof findBillingOfferById>>
>;

function checkoutSessionMatchesBoundSubscriptionCheckout({
  plan,
  checkoutSession,
  stripeCheckoutSessionId,
  billingOffer,
  expectedCustomerId,
  expectedUserId,
}: {
  plan: SubscriptionPlanDefinition;
  checkoutSession: Stripe.Checkout.Session;
  stripeCheckoutSessionId: string;
  billingOffer: PersistedBillingOffer;
  expectedCustomerId: string;
  expectedUserId: string;
}): boolean {
  const lineItems = checkoutSession.line_items?.data;
  return (
    checkoutSession.id === stripeCheckoutSessionId &&
    checkoutSession.mode === "subscription" &&
    getExpandableId(checkoutSession.customer) === expectedCustomerId &&
    checkoutSession.metadata?.planId === plan.id &&
    checkoutSession.metadata?.billingOfferId === billingOffer.id &&
    hasStripeOwnerMetadata(checkoutSession.metadata, expectedUserId) &&
    billingOffer.kind === plan.offerKind &&
    lineItems?.length === 1 &&
    lineItems[0].quantity === 1 &&
    getExpandableId(lineItems[0].price) === billingOffer.stripePriceId
  );
}

function subscriptionMatchesBoundSubscriptionCheckout({
  plan,
  subscription,
  billingOffer,
  expectedCustomerId,
  expectedUserId,
}: {
  plan: SubscriptionPlanDefinition;
  subscription: Stripe.Subscription;
  billingOffer: PersistedBillingOffer;
  expectedCustomerId: string;
  expectedUserId: string;
}): boolean {
  if (
    billingOffer.kind !== plan.offerKind ||
    subscription.items.data.length !== 1 ||
    getExpandableId(subscription.customer) !== expectedCustomerId ||
    subscription.metadata?.planId !== plan.id ||
    subscription.metadata?.billingOfferId !== billingOffer.id ||
    !hasStripeOwnerMetadata(subscription.metadata, expectedUserId)
  ) {
    return false;
  }
  const item = subscription.items.data[0];
  return (
    item.quantity === 1 &&
    item.price.id === billingOffer.stripePriceId &&
    getExpandableId(item.price.product) === billingOffer.stripeProductId &&
    item.price.unit_amount === billingOffer.unitAmount &&
    item.price.currency.toLowerCase() === billingOffer.currency.toLowerCase() &&
    item.price.recurring?.interval === billingOffer.recurringInterval &&
    item.price.recurring.interval_count === billingOffer.recurringIntervalCount
  );
}

async function listPaidInvoicePaymentIntentIds({
  stripe,
  stripeInvoiceId,
}: {
  stripe: StripeClient;
  stripeInvoiceId: string;
}): Promise<Set<string>> {
  const paymentIntentIds = new Set<string>();
  let startingAfter: string | undefined;
  for (;;) {
    const payments = await stripe.invoicePayments.list({
      invoice: stripeInvoiceId,
      status: "paid",
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const payment of payments.data) {
      const paymentIntentId = getExpandableId(payment.payment.payment_intent);
      if (paymentIntentId && (payment.amount_paid ?? 0) > 0) {
        paymentIntentIds.add(paymentIntentId);
      }
    }
    if (!payments.has_more) return paymentIntentIds;
    const lastPayment = payments.data.at(-1);
    if (!lastPayment) {
      throw new Error("Stripe returned an empty invoice-payment page with has_more");
    }
    startingAfter = lastPayment.id;
  }
}

// Every plan whose Checkout is bound to a Session gets the same closure steps;
// the plan only decides which offer kind the Session must match and how a
// superseded completion is labeled.
async function resolveBoundSubscriptionCheckoutsForAccountDeletion({
  stripe,
  expectedCustomerId,
  userId,
}: {
  stripe: StripeClient;
  expectedCustomerId: string;
  userId: string;
}): Promise<void> {
  const attempts = await findBoundSubscriptionCheckoutAttemptsForAccountDeletion({
    userId,
  });
  for (const attempt of attempts) {
    const plan = subscriptionPlanOf(attempt.planId);
    if (!plan) continue;
    await resolveBoundSubscriptionCheckoutForAccountDeletion({
      stripe,
      expectedCustomerId,
      userId,
      attempt,
      plan,
    });
  }
}

async function resolveBoundSubscriptionCheckoutForAccountDeletion({
  stripe,
  expectedCustomerId,
  userId,
  attempt,
  plan,
}: {
  stripe: StripeClient;
  expectedCustomerId: string;
  userId: string;
  attempt: { billingOfferId: string; stripeCheckoutSessionId: string };
  plan: SubscriptionPlanDefinition;
}): Promise<void> {
  const [billingOffer, initialCheckoutSession] = await Promise.all([
    findBillingOfferById({ id: attempt.billingOfferId }),
    stripe.checkout.sessions.retrieve(attempt.stripeCheckoutSessionId, {
      expand: ["line_items.data.price"],
    }),
  ]);
  if (!billingOffer || billingOffer.kind !== plan.offerKind) {
    throw new Error(
      `Bound Checkout Session ${attempt.stripeCheckoutSessionId} has no ${plan.offerKind} billing offer`,
    );
  }

  const retrieveCheckoutSession = async () =>
    await stripe.checkout.sessions.retrieve(attempt.stripeCheckoutSessionId, {
      expand: ["line_items.data.price"],
    });
  const matchesBinding = (checkoutSession: Stripe.Checkout.Session) =>
    checkoutSessionMatchesBoundSubscriptionCheckout({
      plan,
      checkoutSession,
      stripeCheckoutSessionId: attempt.stripeCheckoutSessionId,
      billingOffer,
      expectedCustomerId,
      expectedUserId: userId,
    });

  let checkoutSession = initialCheckoutSession;
  if (!matchesBinding(checkoutSession)) {
    throw new Error(
      `Bound Checkout Session ${attempt.stripeCheckoutSessionId} failed ownership validation`,
    );
  }

  if (checkoutSession.status === "open") {
    try {
      checkoutSession = await stripe.checkout.sessions.expire(
        attempt.stripeCheckoutSessionId,
      );
    } catch (error) {
      checkoutSession = await retrieveCheckoutSession();
      if (
        checkoutSession.status !== "complete" &&
        checkoutSession.status !== "expired"
      ) {
        throw error;
      }
    }
  }

  if (checkoutSession.status === "expired") return;
  if (checkoutSession.status !== "complete") {
    throw new Error(
      `Bound Checkout Session ${attempt.stripeCheckoutSessionId} remains ${checkoutSession.status ?? "unknown"}`,
    );
  }
  if (!checkoutSession.line_items || !matchesBinding(checkoutSession)) {
    checkoutSession = await retrieveCheckoutSession();
  }
  if (!matchesBinding(checkoutSession)) {
    throw new Error(
      `Completed Checkout Session ${attempt.stripeCheckoutSessionId} failed ownership validation`,
    );
  }

  const subscriptionId = getExpandableId(checkoutSession.subscription);
  if (!subscriptionId) {
    throw new Error(
      `Completed Checkout Session ${attempt.stripeCheckoutSessionId} has no subscription`,
    );
  }
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  if (
    getExpandableId(checkoutSession.subscription) !== subscription.id ||
    !subscriptionMatchesBoundSubscriptionCheckout({
      plan,
      subscription,
      billingOffer,
      expectedCustomerId,
      expectedUserId: userId,
    })
  ) {
    throw new Error(
      `Completed Checkout Session ${attempt.stripeCheckoutSessionId} failed subscription validation`,
    );
  }

  const stripeInvoiceId =
    getExpandableId(checkoutSession.invoice) ??
    getExpandableId(subscription.latest_invoice);
  const paymentIntentIds = stripeInvoiceId
    ? await listPaidInvoicePaymentIntentIds({ stripe, stripeInvoiceId })
    : new Set<string>();
  const refundAttempts = await startRetryableTransaction(async (prisma) => {
    const scheduled = [];
    for (const stripePaymentIntentId of
      paymentIntentIds.size > 0 ? [...paymentIntentIds] : [null]) {
      const refundAttempt = await scheduleBillingRefundAttempt({
        disposition: plan.supersededDisposition,
        sourceKey:
          `${checkoutSession.id}:${stripePaymentIntentId ?? "no-payment"}`,
        stripeCustomerId: expectedCustomerId,
        stripeCheckoutSessionId: checkoutSession.id,
        stripeSubscriptionId: subscription.id,
        stripeInvoiceId: stripeInvoiceId ?? null,
        stripePaymentIntentId,
        prisma,
      });
      if (!refundAttempt) {
        throw new Error(
          `Failed to persist account-deletion compensation for ${checkoutSession.id}`,
        );
      }
      scheduled.push(refundAttempt);
    }
    return scheduled;
  });

  if (!isTerminalSubscription(subscription)) {
    try {
      const canceledSubscription = await stripe.subscriptions.cancel(
        subscription.id,
        { invoice_now: false, prorate: false },
        {
          idempotencyKey: `beutl:account-delete:subscription:${subscription.id}`,
        },
      );
      if (!isTerminalSubscription(canceledSubscription)) {
        throw new Error(
          `Subscription ${subscription.id} remains ${canceledSubscription.status} after cancellation`,
        );
      }
    } catch (error) {
      if (!isStripeResourceMissingError(error)) {
        throw error;
      }
    }
  }

  const cancellationCompletedAt = new Date();
  await startRetryableTransaction(async (prisma) => {
    for (const refundAttempt of refundAttempts) {
      const recorded = await recordBillingRefundCancellation({
        attemptId: refundAttempt.id,
        now: cancellationCompletedAt,
        prisma,
      });
      if (!recorded) {
        throw new Error(
          `Failed to persist account-deletion cancellation for ${checkoutSession.id}`,
        );
      }
    }
  });
}

export async function closeStripeCustomerForAccountDeletion({
  userId,
  stripeCustomerId,
  deletionAuthorizedAt,
}: {
  userId: string;
  stripeCustomerId?: string | null;
  deletionAuthorizedAt: Date;
}): Promise<CustomerClosureResult> {
  const mapping =
    stripeCustomerId === undefined
      ? await findCustomerByUserId({ userId })
      : null;
  const customerId =
    stripeCustomerId === undefined ? mapping?.stripeId : stripeCustomerId;
  if (!customerId) {
    return { status: "not-linked" };
  }

  const stripe = createStripe();
  const customer = await retrieveCustomerIfPresent(stripe, customerId);
  if (!customer) {
    return { status: "already-closed", customerId };
  }
  const ownership =
    mapping?.stripeId === customerId
      ? mapping.ownership
      : await findStripeCustomerOwnershipByStripeId({ stripeId: customerId });
  const proof = await verifyCustomerOwnership({ customer, ownership, userId });
  if (proof === "mismatch") {
    return { status: "owner-mismatch", customerId: customer.id };
  }
  if (await countActiveStripeCustomerProvisioning({ userId }) > 0) {
    throw new Error("Stripe Customer provisioning cleanup is pending");
  }
  if (Object.values(await inspectAccountDeletionBillingBlockers({ userId })).some((count) => count > 0)) {
    throw new Error("Checkout recovery is pending before Stripe Customer closure");
  }

  // The attempt retains its Stripe handle after deletion authorization. Resolve
  // it before any destructive Customer operation so a Checkout completion that
  // won the race has a durable refund record before local cascade deletion.
  await resolveBoundSubscriptionCheckoutsForAccountDeletion({
    stripe,
    expectedCustomerId: customer.id,
    userId,
  });

  // Capture and durably handle open Sessions before inspecting recent
  // completions; this closes the list/complete race without touching history.
  let openSessionCursor: string | undefined;
  for (;;) {
    const sessions = await stripe.checkout.sessions.list({ customer: customer.id, status: "open", limit: 100, ...(openSessionCursor ? { starting_after: openSessionCursor } : {}) });
    for (const session of sessions.data) {
      if (!hasStripeOwnerMetadata(session.metadata, userId)) return { status: "owner-mismatch", customerId: customer.id };
      const isPackage = session.metadata?.beutlPurchaseKind === "package" && Boolean(session.metadata.packageId);
      const isTopUp = Boolean(session.metadata?.topUpAttemptId);
      const subscriptionPlan = Boolean(session.metadata?.billingOfferId) && !isTopUp ? (subscriptionPlanOf(session.metadata?.planId ?? "pro")?.id ?? null) : null;
      if (isTopUp) { if (!session.metadata?.topUpAttemptId || (await setTopUpCheckoutSession({ attemptId: session.metadata.topUpAttemptId, stripeCheckoutSessionId: session.id, expiresAt: session.expires_at ? new Date(session.expires_at * 1000) : new Date() })) === "not-stored") return { status: "owner-mismatch", customerId: customer.id }; }
      else if (isPackage) await scheduleStripeCheckoutCleanup({ sessionId: session.id, userId, kind: "package", customerId: customer.id, packageId: session.metadata?.packageId, billingOfferId: null });
      else if (subscriptionPlan) await scheduleStripeCheckoutCleanup({ sessionId: session.id, userId, kind: subscriptionPlan, customerId: customer.id, packageId: null, billingOfferId: session.metadata?.billingOfferId });
      else return { status: "owner-mismatch", customerId: customer.id };
      try { await stripe.checkout.sessions.expire(session.id); } catch (error) { const current = await stripe.checkout.sessions.retrieve(session.id); if (current.status !== "complete" && current.status !== "expired") throw error; }
    }
    if (!sessions.has_more) break;
    openSessionCursor = sessions.data.at(-1)?.id;
    if (!openSessionCursor) throw new Error("Stripe returned an empty Checkout page with has_more");
  }

  let recentCompleteCursor: string | undefined;
  for (;;) {
    const completed = await stripe.checkout.sessions.list({ customer: customer.id, status: "complete", limit: 100, created: { gte: Math.max(0, Math.floor(deletionAuthorizedAt.getTime() / 1000) - 24 * 60 * 60 - 1) }, ...(recentCompleteCursor ? { starting_after: recentCompleteCursor } : {}) });
    for (const session of completed.data) {
      if (!hasStripeOwnerMetadata(session.metadata, userId)) return { status: "owner-mismatch", customerId: customer.id };
      const isPackage = session.metadata?.beutlPurchaseKind === "package" && Boolean(session.metadata.packageId);
      const isTopUp = Boolean(session.metadata?.topUpAttemptId);
      const subscriptionPlan = Boolean(session.metadata?.billingOfferId) && !isTopUp ? (subscriptionPlanOf(session.metadata?.planId ?? "pro")?.id ?? null) : null;
      if (isPackage || isTopUp) {
        const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
        if (!paymentIntentId) return { status: "owner-mismatch", customerId: customer.id };
        let paymentIntent: Stripe.PaymentIntent;
        try { paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId); } catch (error) { if (!isStripeResourceMissingError(error)) throw error; return { status: "owner-mismatch", customerId: customer.id }; }
        const chargeId = typeof paymentIntent.latest_charge === "string" ? paymentIntent.latest_charge : paymentIntent.latest_charge?.id;
        let charge: Stripe.Charge | null;
        try { charge = chargeId ? await stripe.charges.retrieve(chargeId) : null; } catch (error) { if (!isStripeResourceMissingError(error)) throw error; return { status: "owner-mismatch", customerId: customer.id }; }
        if (!charge) return { status: "owner-mismatch", customerId: customer.id };
        if (charge.created < Math.floor(deletionAuthorizedAt.getTime() / 1000)) continue;
        if (isTopUp) {
          if (!session.metadata?.topUpAttemptId || (await setTopUpCheckoutSession({ attemptId: session.metadata.topUpAttemptId, stripeCheckoutSessionId: session.id, expiresAt: session.expires_at ? new Date(session.expires_at * 1000) : new Date() })) === "not-stored") return { status: "owner-mismatch", customerId: customer.id };
        } else await scheduleStripeCheckoutCleanup({ sessionId: session.id, userId, kind: "package", customerId: customer.id, packageId: session.metadata?.packageId, billingOfferId: null });
      } else if (subscriptionPlan) {
        const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
        if (!subscriptionId) return { status: "owner-mismatch", customerId: customer.id };
        let subscription: Stripe.Subscription;
        try { subscription = await stripe.subscriptions.retrieve(subscriptionId); } catch (error) { if (!isStripeResourceMissingError(error)) throw error; return { status: "owner-mismatch", customerId: customer.id }; }
        if (subscription.created < Math.floor(deletionAuthorizedAt.getTime() / 1000)) continue;
        await scheduleStripeCheckoutCleanup({ sessionId: session.id, userId, kind: subscriptionPlan, customerId: customer.id, packageId: null, billingOfferId: session.metadata?.billingOfferId });
      } else return { status: "owner-mismatch", customerId: customer.id };
    }
    if (!completed.has_more) break;
    recentCompleteCursor = completed.data.at(-1)?.id;
    if (!recentCompleteCursor) throw new Error("Stripe returned an empty completed Checkout page with has_more");
  }

  let startingAfter: string | undefined;
  while (true) {
    let subscriptions: Stripe.ApiList<Stripe.Subscription>;
    try {
      subscriptions = await stripe.subscriptions.list({
        customer: customer.id,
        status: "all",
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
    } catch (error) {
      if (isStripeResourceMissingError(error)) {
        return { status: "already-closed", customerId: customer.id };
      }
      throw error;
    }

    for (const subscription of subscriptions.data) {
      if (isTerminalSubscription(subscription)) {
        continue;
      }
      try {
        const canceledSubscription = await stripe.subscriptions.cancel(
          subscription.id,
          {
            invoice_now: false,
            prorate: false,
          },
          {
            idempotencyKey: `beutl:account-delete:subscription:${subscription.id}`,
          },
        );
        if (!isTerminalSubscription(canceledSubscription)) {
          throw new Error(
            `Subscription ${subscription.id} remains ${canceledSubscription.status} after cancellation`,
          );
        }
      } catch (error) {
        if (!isStripeResourceMissingError(error)) {
          throw error;
        }
      }
    }

    if (!subscriptions.has_more) {
      break;
    }
    const lastSubscription = subscriptions.data.at(-1);
    if (!lastSubscription) {
      throw new Error("Stripe returned an empty subscription page with has_more");
    }
    startingAfter = lastSubscription.id;
  }

  const finalOpen = await stripe.checkout.sessions.list({ customer: customer.id, status: "open", limit: 100 });
  if (finalOpen.data.length > 0 || finalOpen.has_more) return { status: "owner-mismatch", customerId: customer.id };

  try {
    await stripe.customers.del(
      customer.id,
      {},
      {
        idempotencyKey: `beutl:account-delete:customer:${customer.id}`,
      },
    );
  } catch (error) {
    if (!isStripeResourceMissingError(error)) {
      throw error;
    }
  }

  return { status: "closed", customerId: customer.id };
}
