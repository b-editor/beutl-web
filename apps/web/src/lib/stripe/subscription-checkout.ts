// The plan-agnostic parts of a subscription Checkout: matching a Session or a
// subscription to a persisted offer, compensating a Session that completed
// after it was superseded, the portal configuration guard, and the two-attempt
// create loop. Every plan goes through the same functions; callers only name
// the plan (and tier) they are selling.
import { allowsStripePromotionCodes } from "@beutl/core";
import {
  bindSubscriptionCheckoutSession,
  deleteBoundSubscriptionCheckoutAttempt,
  findBillingOfferById,
  findCustomerByUserId,
  findStripeCustomerOwnershipByStripeId,
  findSubscriptionCheckoutAttemptBySessionId,
  getOrCreateSubscriptionCheckoutAttempt,
  getSubscription,
  reconcileSubscriptionObservation,
  recordBillingRefundCancellation,
  scheduleBillingRefundAttempt,
  setSubscriptionCheckoutAttemptParams,
  startRetryableTransaction,
} from "@beutl/db";
import { redirect } from "next/navigation";
import type Stripe from "stripe";
import { getSubscriptionPeriod } from "./ai-billing";
import {
  getScheduledCancellationTime,
  isCancellationScheduled,
} from "./cancellation";
import type { createStripe } from "./config";
import {
  getExpandableId as expandableId,
  getStripeCustomerOwnershipProof,
  hasStripeOwnerMetadata,
  stripeOwnerMetadata,
} from "./ownership";
import {
  activateConfiguredSubscriptionOffer,
  blocksNewSubscriptionCheckout,
  resolveSubscriptionOffer,
} from "./subscription-billing";
import {
  configuredPriceIds,
  type SubscriptionPlanConfig,
} from "./subscription-plans";

const BILLING_PATH = "/dashboard/account/billing";

function origin(): string {
  return process.env.PUBLIC_ORIGIN || "https://beutl.beditor.net";
}

export type PersistedBillingOffer = Pick<
  NonNullable<Awaited<ReturnType<typeof findBillingOfferById>>>,
  | "id"
  | "kind"
  | "stripePriceId"
  | "stripeProductId"
  | "unitAmount"
  | "currency"
  | "creditAmount"
  | "recurringInterval"
  | "recurringIntervalCount"
  | "tier"
>;

export function checkoutSessionMatchesOffer(
  plan: SubscriptionPlanConfig,
  checkoutSession: Stripe.Checkout.Session,
  billingOffer: PersistedBillingOffer,
): boolean {
  const lineItems = checkoutSession.line_items?.data;
  return (
    billingOffer.kind === plan.offerKind &&
    lineItems?.length === 1 &&
    lineItems[0].quantity === 1 &&
    expandableId(lineItems[0].price) === billingOffer.stripePriceId
  );
}

export function subscriptionMatchesOffer(
  plan: SubscriptionPlanConfig,
  subscription: Stripe.Subscription,
  billingOffer: PersistedBillingOffer,
): boolean {
  if (
    billingOffer.kind !== plan.offerKind ||
    subscription.metadata?.planId !== plan.id ||
    subscription.metadata?.billingOfferId !== billingOffer.id ||
    subscription.items.data.length !== 1
  ) {
    return false;
  }
  const item = subscription.items.data[0];
  return (
    item.quantity === 1 &&
    item.price.id === billingOffer.stripePriceId &&
    expandableId(item.price.product) === billingOffer.stripeProductId &&
    item.price.unit_amount === billingOffer.unitAmount &&
    item.price.currency.toLowerCase() === billingOffer.currency.toLowerCase() &&
    item.price.recurring?.interval === billingOffer.recurringInterval &&
    item.price.recurring.interval_count ===
      billingOffer.recurringIntervalCount
  );
}

export function canonicalizeCheckoutParams(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeCheckoutParams);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalizeCheckoutParams(item)]),
    );
  }
  return value;
}

export async function expireOpenCheckoutSession(
  stripe: ReturnType<typeof createStripe>,
  checkoutSession: Stripe.Checkout.Session,
): Promise<Stripe.Checkout.Session> {
  if (checkoutSession.status !== "open") {
    return checkoutSession;
  }
  const retrieveExpanded = () =>
    stripe.checkout.sessions.retrieve(checkoutSession.id, {
      expand: ["line_items.data.price"],
    });
  try {
    const resolved = await stripe.checkout.sessions.expire(checkoutSession.id);
    // Stripe normally returns an expired Session here. Defensively hydrate a
    // completed result before callers perform exact line-item validation.
    return resolved.status === "complete"
      ? await retrieveExpanded()
      : resolved;
  } catch (error) {
    const resolved = await retrieveExpanded();
    if (resolved.status !== "complete" && resolved.status !== "expired") {
      throw error;
    }
    return resolved;
  }
}

export function persistedCheckoutParams(
  paramsJson: string,
  current: Stripe.Checkout.SessionCreateParams,
): Stripe.Checkout.SessionCreateParams {
  let persisted: unknown;
  try {
    persisted = JSON.parse(paramsJson);
  } catch {
    throw new Error(
      "Persisted Pro Checkout parameters do not match the current offer",
    );
  }
  const legacy = { ...current };
  delete legacy.allow_promotion_codes;
  const canonicalPersisted = JSON.stringify(
    canonicalizeCheckoutParams(persisted),
  );
  const canonicalCurrent = JSON.stringify(canonicalizeCheckoutParams(current));
  const canonicalLegacy = JSON.stringify(canonicalizeCheckoutParams(legacy));
  if (
    canonicalPersisted !== canonicalCurrent &&
    canonicalPersisted !== canonicalLegacy
  ) {
    throw new Error(
      "Persisted Pro Checkout parameters do not match the current offer",
    );
  }
  return persisted as Stripe.Checkout.SessionCreateParams;
}

export async function compensateSupersededSubscriptionCheckout({
  plan,
  stripe,
  checkoutSession,
  subscription,
  billingOffer,
  expectedCustomerId,
  expectedUserId,
}: {
  plan: SubscriptionPlanConfig;
  stripe: ReturnType<typeof createStripe>;
  checkoutSession: Stripe.Checkout.Session;
  subscription: Stripe.Subscription;
  billingOffer: PersistedBillingOffer;
  expectedCustomerId: string;
  expectedUserId: string;
}): Promise<boolean> {
  if (
    checkoutSession.status !== "complete" ||
    checkoutSession.mode !== "subscription" ||
    expandableId(checkoutSession.customer) !== expectedCustomerId ||
    expandableId(checkoutSession.subscription) !== subscription.id ||
    checkoutSession.metadata?.planId !== plan.id ||
    checkoutSession.metadata?.billingOfferId !== billingOffer.id ||
    !hasStripeOwnerMetadata(checkoutSession.metadata, expectedUserId) ||
    expandableId(subscription.customer) !== expectedCustomerId ||
    !hasStripeOwnerMetadata(subscription.metadata, expectedUserId) ||
    !subscriptionMatchesOffer(plan, subscription, billingOffer)
  ) {
    throw new Error(
      `Superseded Checkout Session ${checkoutSession.id} failed compensation validation`,
    );
  }

  const invoiceId =
    expandableId(checkoutSession.invoice) ??
    expandableId(subscription.latest_invoice);
  const paymentIntentIds = new Set<string>();
  if (invoiceId) {
    let startingAfter: string | undefined;
    for (;;) {
      const payments = await stripe.invoicePayments.list({
        invoice: invoiceId,
        status: "paid",
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      for (const payment of payments.data) {
        const paymentIntentId = expandableId(payment.payment.payment_intent);
        if (paymentIntentId && (payment.amount_paid ?? 0) > 0) {
          paymentIntentIds.add(paymentIntentId);
        }
      }
      if (!payments.has_more) break;
      const lastPayment = payments.data.at(-1);
      if (!lastPayment) {
        throw new Error(
          "Stripe returned an empty invoice-payment page with has_more",
        );
      }
      startingAfter = lastPayment.id;
    }
  }

  const customerId = expandableId(subscription.customer);
  if (!customerId) {
    throw new Error(`Subscription ${subscription.id} has no customer`);
  }
  const refundAttempts = await startRetryableTransaction(async (tx) => {
    const attempts = [];
    for (const paymentIntentId of
      paymentIntentIds.size > 0 ? [...paymentIntentIds] : [null]) {
        const attempt = await scheduleBillingRefundAttempt({
          disposition: plan.supersededDisposition,
          sourceKey:
            `${checkoutSession.id}:${paymentIntentId ?? "no-payment"}`,
          stripeCustomerId: customerId,
          stripeCheckoutSessionId: checkoutSession.id,
          stripeSubscriptionId: subscription.id,
          stripeInvoiceId: invoiceId,
          stripePaymentIntentId: paymentIntentId,
          prisma: tx,
        });
        if (!attempt) {
          throw new Error("Failed to persist superseded Checkout compensation");
        }
        attempts.push(attempt);
    }
    return attempts;
  });

  try {
    let canceledSubscription = subscription;
    if (
      subscription.status !== "canceled" &&
      subscription.status !== "incomplete_expired"
    ) {
      canceledSubscription = await stripe.subscriptions.cancel(
        subscription.id,
        { invoice_now: false, prorate: false },
        {
          idempotencyKey:
            `beutl:${plan.supersededDisposition}-cancel:${checkoutSession.id}`,
        },
      );
    }
    if (
      canceledSubscription.status !== "canceled" &&
      canceledSubscription.status !== "incomplete_expired"
    ) {
      throw new Error(
        `Subscription ${subscription.id} remains ${canceledSubscription.status} after compensation cancellation`,
      );
    }
    const canceledAt = new Date();
    const cancellationRecorded = await Promise.all(
      refundAttempts.map((attempt) =>
        recordBillingRefundCancellation({
          attemptId: attempt.id,
          now: canceledAt,
        })
      ),
    );
    if (!cancellationRecorded.every(Boolean)) {
      throw new Error(
        `Failed to record cancellation for superseded Checkout Session ${checkoutSession.id}`,
      );
    }
    return true;
  } catch (error) {
    console.error("Superseded Checkout compensation was queued", {
      stripeCheckoutSessionId: checkoutSession.id,
      stripeSubscriptionId: subscription.id,
      error,
    });
    return false;
  }
}

export function subscriptionCheckoutSessionMatchesBinding({
  plan,
  checkoutSession,
  stripeCheckoutSessionId,
  billingOffer,
  expectedCustomerId,
  expectedUserId,
}: {
  plan: SubscriptionPlanConfig;
  checkoutSession: Stripe.Checkout.Session;
  stripeCheckoutSessionId: string;
  billingOffer: PersistedBillingOffer;
  expectedCustomerId: string;
  expectedUserId: string;
}): boolean {
  return (
    checkoutSession.id === stripeCheckoutSessionId &&
    checkoutSession.mode === "subscription" &&
    expandableId(checkoutSession.customer) === expectedCustomerId &&
    checkoutSession.metadata?.planId === plan.id &&
    checkoutSession.metadata?.billingOfferId === billingOffer.id &&
    hasStripeOwnerMetadata(checkoutSession.metadata, expectedUserId) &&
    checkoutSessionMatchesOffer(plan, checkoutSession, billingOffer)
  );
}

export async function resolveRejectedSubscriptionCheckoutSession({
  plan,
  stripe,
  stripeCheckoutSessionId,
  billingOffer,
  expectedCustomerId,
  expectedUserId,
}: {
  plan: SubscriptionPlanConfig;
  stripe: ReturnType<typeof createStripe>;
  stripeCheckoutSessionId: string;
  billingOffer: PersistedBillingOffer;
  expectedCustomerId: string;
  expectedUserId: string;
}): Promise<boolean> {
  const retrieve = async () =>
    await stripe.checkout.sessions.retrieve(stripeCheckoutSessionId, {
      expand: ["line_items.data.price"],
    });
  let checkoutSession = await retrieve();
  if (
    !subscriptionCheckoutSessionMatchesBinding({
      plan,
      checkoutSession,
      stripeCheckoutSessionId,
      billingOffer,
      expectedCustomerId,
      expectedUserId,
    })
  ) {
    throw new Error(
      `Rejected Checkout Session ${stripeCheckoutSessionId} failed ownership validation`,
    );
  }

  if (checkoutSession.status === "open") {
    try {
      checkoutSession = await stripe.checkout.sessions.expire(
        stripeCheckoutSessionId,
      );
    } catch (error) {
      checkoutSession = await retrieve();
      if (
        checkoutSession.status !== "complete" &&
        checkoutSession.status !== "expired"
      ) {
        throw error;
      }
    }
  }

  if (checkoutSession.status === "expired") {
    return true;
  }
  if (checkoutSession.status !== "complete") {
    throw new Error(
      `Rejected Checkout Session ${stripeCheckoutSessionId} remains ${checkoutSession.status ?? "unknown"}`,
    );
  }
  if (
    !checkoutSession.line_items ||
    !subscriptionCheckoutSessionMatchesBinding({
      plan,
      checkoutSession,
      stripeCheckoutSessionId,
      billingOffer,
      expectedCustomerId,
      expectedUserId,
    })
  ) {
    checkoutSession = await retrieve();
  }
  if (
    !subscriptionCheckoutSessionMatchesBinding({
      plan,
      checkoutSession,
      stripeCheckoutSessionId,
      billingOffer,
      expectedCustomerId,
      expectedUserId,
    })
  ) {
    throw new Error(
      `Completed Checkout Session ${stripeCheckoutSessionId} failed ownership validation`,
    );
  }

  const subscriptionId = expandableId(checkoutSession.subscription);
  if (!subscriptionId) {
    throw new Error(
      `Completed Checkout Session ${checkoutSession.id} has no subscription`,
    );
  }
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  return await compensateSupersededSubscriptionCheckout({
    plan,
    stripe,
    checkoutSession,
    subscription,
    billingOffer,
    expectedCustomerId,
    expectedUserId,
  });
}

export async function getSafeBillingPortalConfigurationId(
  stripe: ReturnType<typeof createStripe>,
  // Required only by the flow that actually needs it. Demanding it globally
  // would make cancellation fail whenever an operator turns payment method
  // updates off, which is a feature cancellation does not depend on.
  options?: { requirePaymentMethodUpdate?: boolean },
): Promise<string> {
  const configurationId = process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID;
  if (!configurationId) {
    throw new Error("STRIPE_BILLING_PORTAL_CONFIGURATION_ID is not set");
  }
  const configuration = await stripe.billingPortal.configurations.retrieve(
    configurationId,
  );
  if (
    !configuration.active ||
    !configuration.features.subscription_cancel.enabled ||
    configuration.features.subscription_cancel.mode !== "at_period_end" ||
    configuration.features.subscription_update.enabled
  ) {
    throw new Error(
      "The Stripe billing portal must cancel at period end and disable subscription switching",
    );
  }
  if (
    options?.requirePaymentMethodUpdate &&
    !configuration.features.payment_method_update?.enabled
  ) {
    throw new Error(
      "The Stripe billing portal must allow payment method updates",
    );
  }
  return configuration.id;
}

export async function hasBlockingStripeSubscription(
  stripe: ReturnType<typeof createStripe>,
  customerId: string,
  recognizedPriceIds: ReadonlySet<string>,
  blocks: (
    subscription: Stripe.Subscription,
    recognizedPriceIds: ReadonlySet<string>,
  ) => boolean,
): Promise<boolean> {
  let startingAfter: string | undefined;
  for (;;) {
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    if (
      subscriptions.data.some((item) => blocks(item, recognizedPriceIds))
    ) {
      return true;
    }
    if (!subscriptions.has_more) {
      return false;
    }
    const lastSubscription = subscriptions.data.at(-1);
    if (!lastSubscription) {
      throw new Error("Stripe returned an empty subscription page with has_more");
    }
    startingAfter = lastSubscription.id;
  }
}


// The two-attempt Checkout loop. Reuses an open bound Session, expires or
// compensates a stale one, and creates a new Session under a durable
// idempotency key. Always ends in a redirect.
export async function runSubscriptionCheckout({
  stripe,
  userId,
  customerId,
  offer,
  checkoutParams,
  plan,
  tier,
}: {
  stripe: ReturnType<typeof createStripe>;
  userId: string;
  customerId: string;
  offer: PersistedBillingOffer;
  checkoutParams: Stripe.Checkout.SessionCreateParams;
  plan: SubscriptionPlanConfig;
  tier: string | null;
}): Promise<never> {
  const recognizedPriceIds = configuredPriceIds(plan);
  // A bound Session may be reused only for the offer being asked for now: the
  // same plan, a recognized Price, and the same tier. Anything else is expired
  // and replaced, so a user who started one tier and clicks another is not
  // sent back to the old Checkout.
  const isReusableBoundOffer = (candidate: PersistedBillingOffer): boolean =>
    candidate.kind === plan.offerKind &&
    recognizedPriceIds.has(candidate.stripePriceId) &&
    (candidate.tier ?? null) === tier;
  for (let attemptNumber = 0; attemptNumber < 2; attemptNumber++) {
    const now = new Date();
    const attempt = await getOrCreateSubscriptionCheckoutAttempt({
      planId: plan.id,
      tier,
      userId: userId,
      billingOfferId: offer.id,
      now,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      customerId,
      paramsJson: JSON.stringify(checkoutParams),
    });

    if (attempt.stripeCheckoutSessionId) {
      const [existingSession, attemptOffer] = await Promise.all([
        stripe.checkout.sessions.retrieve(attempt.stripeCheckoutSessionId, {
          expand: ["line_items.data.price"],
        }),
        findBillingOfferById({ id: attempt.billingOfferId }),
      ]);
      const isValidatedBoundSession = (
        candidate: Stripe.Checkout.Session,
      ): boolean =>
        attemptOffer !== null &&
        candidate.id === attempt.stripeCheckoutSessionId &&
        candidate.mode === "subscription" &&
        expandableId(candidate.customer) === customerId &&
        candidate.metadata?.planId === plan.id &&
        candidate.metadata?.billingOfferId === attempt.billingOfferId &&
        hasStripeOwnerMetadata(candidate.metadata, userId) &&
        checkoutSessionMatchesOffer(plan, candidate, attemptOffer);
      const authorizedOffer =
        attemptOffer !== null && isReusableBoundOffer(attemptOffer);
      const promotionCodesEnabled = allowsStripePromotionCodes(
        attempt.paramsJson,
      );
      if (!isValidatedBoundSession(existingSession)) {
        if (
          existingSession.id === attempt.stripeCheckoutSessionId &&
          existingSession.status === "expired"
        ) {
          await deleteBoundSubscriptionCheckoutAttempt({
            userId: userId,
            checkoutKey: attempt.checkoutKey,
            stripeCheckoutSessionId: attempt.stripeCheckoutSessionId,
          });
          continue;
        }
        throw new Error(
          `Bound Checkout Session ${attempt.stripeCheckoutSessionId} failed validation before its Stripe state was safely resolved`,
        );
      }
      if (
        authorizedOffer &&
        existingSession.status === "open" &&
        existingSession.url &&
        promotionCodesEnabled
      ) {
        redirect(existingSession.url);
      }
      if (
        authorizedOffer &&
        existingSession.status === "complete"
      ) {
        redirect(
          `/dashboard/account/billing?checkout=${plan.checkoutSuccessParam}&session_id=${existingSession.id}`,
        );
      }

      let finalSession = existingSession;
      if (existingSession.status === "open") {
        try {
          finalSession = await stripe.checkout.sessions.expire(
            existingSession.id,
          );
        } catch (error) {
          finalSession = await stripe.checkout.sessions.retrieve(
            existingSession.id,
            { expand: ["line_items.data.price"] },
          );
          if (
            finalSession.status !== "complete" &&
            finalSession.status !== "expired"
          ) {
            throw error;
          }
        }
      }

      if (
        finalSession.status === "complete" &&
        (!attemptOffer || !isValidatedBoundSession(finalSession))
      ) {
        finalSession = await stripe.checkout.sessions.retrieve(
          finalSession.id,
          { expand: ["line_items.data.price"] },
        );
      }
      if (
        authorizedOffer &&
        finalSession.status === "complete" &&
        isValidatedBoundSession(finalSession)
      ) {
        redirect(
          `/dashboard/account/billing?checkout=${plan.checkoutSuccessParam}&session_id=${finalSession.id}`,
        );
      }
      if (finalSession.status === "complete") {
        if (!attemptOffer || !isValidatedBoundSession(finalSession)) {
          throw new Error(
            `Completed Checkout Session ${attempt.stripeCheckoutSessionId} failed validation before compensation`,
          );
        }
        const subscriptionId = expandableId(finalSession.subscription);
        if (!subscriptionId) {
          throw new Error(
            `Completed Checkout Session ${finalSession.id} has no subscription`,
          );
        }
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const cancellationConfirmed = await compensateSupersededSubscriptionCheckout({
          plan,
          stripe,
          checkoutSession: finalSession,
          subscription,
          billingOffer: attemptOffer,
          expectedCustomerId: customerId,
          expectedUserId: userId,
        });
        if (!cancellationConfirmed) {
          redirect("/dashboard/account/billing");
        }
        await deleteBoundSubscriptionCheckoutAttempt({
          userId: userId,
          checkoutKey: attempt.checkoutKey,
          stripeCheckoutSessionId: attempt.stripeCheckoutSessionId,
        });
        continue;
      }
      if (finalSession.status === "expired") {
        await deleteBoundSubscriptionCheckoutAttempt({
          userId: userId,
          checkoutKey: attempt.checkoutKey,
          stripeCheckoutSessionId: attempt.stripeCheckoutSessionId,
        });
        continue;
      }
      throw new Error(
        `Checkout Session ${attempt.stripeCheckoutSessionId} remains ${finalSession.status ?? "unknown"}`,
      );
    }

    let createParams = checkoutParams;
    if (attempt.paramsJson) {
      // Preserve the exact parameters attached to this idempotency key. An
      // attempt started before promotion codes were enabled may already exist
      // at Stripe even when its create response never reached this process.
      createParams = persistedCheckoutParams(
        attempt.paramsJson,
        checkoutParams,
      );
    } else {
      const persisted = await setSubscriptionCheckoutAttemptParams({
        userId: userId,
        checkoutKey: attempt.checkoutKey,
        paramsJson: JSON.stringify(checkoutParams),
      });
      if (persisted.count !== 1) {
        continue;
      }
    }
    const checkoutSession = await stripe.checkout.sessions.create(
      createParams,
      {
        idempotencyKey: `${plan.checkoutIdempotencyPrefix}:${attempt.checkoutKey}`,
      },
    );
    const binding = await bindSubscriptionCheckoutSession({
      planId: plan.id,
      userId: userId,
      checkoutKey: attempt.checkoutKey,
      stripeCheckoutSessionId: checkoutSession.id,
      expiresAt: checkoutSession.expires_at
        ? new Date(checkoutSession.expires_at * 1000)
        : attempt.expiresAt,
    });
    if (binding === "account-deletion-authorized") {
      const cancellationConfirmed = await resolveRejectedSubscriptionCheckoutSession({
        plan,
        stripe,
        stripeCheckoutSessionId: checkoutSession.id,
        billingOffer: offer,
        expectedCustomerId: customerId,
        expectedUserId: userId,
      });
      if (!cancellationConfirmed) {
        redirect("/dashboard/account/billing");
      }
      await deleteBoundSubscriptionCheckoutAttempt({
        userId: userId,
        checkoutKey: attempt.checkoutKey,
        stripeCheckoutSessionId: checkoutSession.id,
      });
      redirect("/dashboard/account/billing");
    }
    if (binding === "superseded") {
      let finalSession: Stripe.Checkout.Session;
      try {
        finalSession = await stripe.checkout.sessions.expire(checkoutSession.id);
      } catch (error) {
        finalSession = await stripe.checkout.sessions.retrieve(
          checkoutSession.id,
          { expand: ["line_items.data.price"] },
        );
        if (
          finalSession.status !== "complete" &&
          finalSession.status !== "expired"
        ) {
          throw error;
        }
      }
      if (finalSession.status === "complete") {
        const subscriptionId = expandableId(finalSession.subscription);
        if (!subscriptionId) {
          throw new Error(
            `Completed Checkout Session ${finalSession.id} has no subscription`,
          );
        }
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const cancellationConfirmed = await compensateSupersededSubscriptionCheckout({
          plan,
          stripe,
          checkoutSession: finalSession,
          subscription,
          billingOffer: offer,
          expectedCustomerId: customerId,
          expectedUserId: userId,
        });
        if (!cancellationConfirmed) {
          redirect("/dashboard/account/billing");
        }
      }
      continue;
    }

    if (!allowsStripePromotionCodes(createParams)) {
      const finalSession = await expireOpenCheckoutSession(
        stripe,
        checkoutSession,
      );
      if (finalSession.status === "complete") {
        redirect(
          `/dashboard/account/billing?checkout=${plan.checkoutSuccessParam}&session_id=${finalSession.id}`,
        );
      }
      if (finalSession.status === "expired") {
        await deleteBoundSubscriptionCheckoutAttempt({
          userId: userId,
          checkoutKey: attempt.checkoutKey,
          stripeCheckoutSessionId: checkoutSession.id,
        });
        continue;
      }
      throw new Error(
        `Pre-promotion Checkout Session ${checkoutSession.id} remains ${finalSession.status ?? "unknown"}`,
      );
    }

    if (!checkoutSession.url) {
      console.error("Checkout session URL is missing");
      redirect("/dashboard/account/billing");
    }
    redirect(checkoutSession.url);
  }

  redirect("/dashboard/account/billing");
}

// Start a Checkout for one plan and tier. Stripe is the source of truth for
// whether a subscription still blocks a new checkout: a refund can cancel the
// subscription in Stripe while the local row keeps its last non-terminal
// status, and trusting that row would leave the user unable to resubscribe
// until the stored period finally elapsed. Always ends in a redirect.
export async function createSubscriptionCheckout({
  stripe,
  plan,
  tier,
  userId,
  customerId,
}: {
  stripe: ReturnType<typeof createStripe>;
  plan: SubscriptionPlanConfig;
  tier: string | null;
  userId: string;
  customerId: string;
}): Promise<never> {
  const offer = await activateConfiguredSubscriptionOffer(plan, stripe, tier);
  if (
    await hasBlockingStripeSubscription(
      stripe,
      customerId,
      configuredPriceIds(plan),
      blocksNewSubscriptionCheckout,
    )
  ) {
    redirect(BILLING_PATH);
  }

  const metadata = {
    ...stripeOwnerMetadata(userId),
    planId: plan.id,
    billingOfferId: offer.id,
    ...(tier === null ? {} : { tier }),
  };
  const checkoutParams: Stripe.Checkout.SessionCreateParams = {
    customer: customerId,
    mode: "subscription",
    allow_promotion_codes: true,
    line_items: [{ price: offer.stripePriceId, quantity: 1 }],
    metadata,
    subscription_data: { metadata },
    success_url: `${origin()}${BILLING_PATH}?checkout=${plan.checkoutSuccessParam}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin()}${BILLING_PATH}`,
  };
  return await runSubscriptionCheckout({
    stripe,
    userId,
    customerId,
    offer,
    checkoutParams,
    plan,
    tier,
  });
}

// Validates the Session the user came back with and records the subscription
// immediately, without waiting for the webhook. The success URL is
// user-controlled: an expired, forged, or inaccessible session must not
// prevent the account page from rendering, so every failure is a quiet false.
export async function reconcileSubscriptionCheckoutSuccess({
  stripe,
  plan,
  userId,
  stripeCheckoutSessionId,
}: {
  stripe: ReturnType<typeof createStripe>;
  plan: SubscriptionPlanConfig;
  userId: string;
  stripeCheckoutSessionId: string;
}): Promise<boolean> {
  if (!stripeCheckoutSessionId.startsWith("cs_")) {
    return false;
  }
  let checkoutSession: Stripe.Checkout.Session;
  try {
    checkoutSession = await stripe.checkout.sessions.retrieve(
      stripeCheckoutSessionId,
    );
  } catch {
    return false;
  }
  const customerId = expandableId(checkoutSession.customer);
  if (
    checkoutSession.id !== stripeCheckoutSessionId ||
    checkoutSession.status !== "complete" ||
    checkoutSession.mode !== "subscription" ||
    checkoutSession.metadata?.planId !== plan.id ||
    !customerId ||
    !hasStripeOwnerMetadata(checkoutSession.metadata, userId)
  ) {
    return false;
  }
  const ownership = await findStripeCustomerOwnershipByStripeId({
    stripeId: customerId,
  });
  if (
    getStripeCustomerOwnershipProof({
      customerId,
      metadata: checkoutSession.metadata,
      ownership,
      userId,
    }) === "mismatch"
  ) {
    return false;
  }
  const currentCustomer = await findCustomerByUserId({ userId });
  const usesCurrentCustomer = currentCustomer?.stripeId === customerId;
  if (
    checkoutSession.payment_status !== "paid" &&
    checkoutSession.payment_status !== "no_payment_required"
  ) {
    return false;
  }
  const subscriptionId = expandableId(checkoutSession.subscription);
  if (!subscriptionId) {
    return false;
  }
  const [subscription, attempt, stored] = await Promise.all([
    stripe.subscriptions.retrieve(subscriptionId),
    findSubscriptionCheckoutAttemptBySessionId({
      userId,
      stripeCheckoutSessionId,
    }),
    getSubscription({ userId, planId: plan.id }),
  ]);
  if (
    !Number.isSafeInteger(subscription.created) ||
    subscription.created < 0
  ) {
    return false;
  }
  const subscriptionCreatedAt = new Date(subscription.created * 1_000);
  if (
    expandableId(subscription.customer) !== customerId ||
    !hasStripeOwnerMetadata(subscription.metadata, userId)
  ) {
    return false;
  }
  if (
    usesCurrentCustomer &&
    !attempt &&
    stored?.stripeSubscriptionId !== subscription.id
  ) {
    return false;
  }
  if (attempt) {
    const attemptOffer = await findBillingOfferById({
      id: attempt.billingOfferId,
    });
    if (
      !attemptOffer ||
      checkoutSession.metadata?.billingOfferId !== attempt.billingOfferId ||
      !subscriptionMatchesOffer(plan, subscription, attemptOffer)
    ) {
      return false;
    }
    if (!configuredPriceIds(plan).has(attemptOffer.stripePriceId)) {
      const cancellationConfirmed = await compensateSupersededSubscriptionCheckout({
        plan,
        stripe,
        checkoutSession,
        subscription,
        billingOffer: attemptOffer,
        expectedCustomerId: customerId,
        expectedUserId: userId,
      });
      if (cancellationConfirmed) {
        await deleteBoundSubscriptionCheckoutAttempt({
          userId,
          checkoutKey: attempt.checkoutKey,
          stripeCheckoutSessionId,
        });
      }
      return false;
    }
  }
  const offer = await resolveSubscriptionOffer(plan, stripe, subscription, {
    ownershipVerified: true,
  });
  if (!offer || checkoutSession.metadata?.billingOfferId !== offer.id) {
    return false;
  }
  if (attempt && attempt.billingOfferId !== offer.id) {
    return false;
  }
  if (!usesCurrentCustomer) {
    const cancellationConfirmed = await compensateSupersededSubscriptionCheckout({
      plan,
      stripe,
      checkoutSession,
      subscription,
      billingOffer: offer,
      expectedCustomerId: customerId,
      expectedUserId: userId,
    });
    if (cancellationConfirmed && attempt) {
      await deleteBoundSubscriptionCheckoutAttempt({
        userId,
        checkoutKey: attempt.checkoutKey,
        stripeCheckoutSessionId,
      });
    }
    return false;
  }
  if (!attempt && stored?.stripeSubscriptionId !== subscription.id) {
    return false;
  }
  if (
    stored?.stripeSubscriptionId !== subscription.id &&
    stored?.stripeEventCreatedAt !== null &&
    stored?.stripeEventCreatedAt !== undefined &&
    subscriptionCreatedAt.getTime() <= stored.stripeEventCreatedAt.getTime()
  ) {
    return false;
  }
  const period = getSubscriptionPeriod(subscription);
  const reconciliation = await reconcileSubscriptionObservation({
    userId,
    stripeSubscriptionId: subscription.id,
    status: subscription.status,
    planId: plan.id,
    tier: offer.tier,
    billingOfferId: offer.id,
    ...period,
    cancelAtPeriodEnd: isCancellationScheduled(subscription),
    cancelAt: getScheduledCancellationTime(subscription),
    stripeSubscriptionCreatedAt: subscriptionCreatedAt,
    stripeEventId: `checkout:${checkoutSession.id}`,
    stripeEventCreatedAt: subscriptionCreatedAt,
    stripeCanonicalObservedAt: new Date(),
    replaceExistingSubscription: true,
  });
  if (reconciliation.subscription?.stripeSubscriptionId !== subscription.id) {
    return false;
  }
  if (attempt) {
    await deleteBoundSubscriptionCheckoutAttempt({
      userId,
      checkoutKey: attempt.checkoutKey,
      stripeCheckoutSessionId,
    });
  }
  return true;
}

export type SubscriptionTierChangeOutcome =
  | "changed"
  | "unchanged"
  | "no-subscription"
  | "not-active"
  | "payment-failed"
  | "blocked";

// Switch the live subscription of a plan to another tier. The difference is
// invoiced and charged immediately; if the charge fails Stripe leaves the
// subscription unchanged. `canChange` lets the caller refuse a change on its
// own grounds (a storage downgrade below the current usage, for instance)
// before Stripe is touched.
export async function changeSubscriptionTier({
  stripe,
  plan,
  tier,
  userId,
  canChange,
}: {
  stripe: ReturnType<typeof createStripe>;
  plan: SubscriptionPlanConfig;
  tier: string;
  userId: string;
  canChange?: (from: string | null, to: string) => Promise<boolean>;
}): Promise<SubscriptionTierChangeOutcome> {
  const newOffer = await activateConfiguredSubscriptionOffer(plan, stripe, tier);
  const stored = await getSubscription({ userId, planId: plan.id });
  if (
    !stored ||
    stored.status === "canceled" ||
    stored.status === "incomplete_expired"
  ) {
    return "no-subscription";
  }
  const customer = await findCustomerByUserId({ userId });
  const subscription = await stripe.subscriptions.retrieve(
    stored.stripeSubscriptionId,
  );
  if (
    !customer ||
    expandableId(subscription.customer) !== customer.stripeId ||
    getStripeCustomerOwnershipProof({
      customerId: customer.stripeId,
      metadata: subscription.metadata,
      ownership: customer.ownership,
      userId,
    }) === "mismatch" ||
    subscription.metadata?.planId !== plan.id ||
    subscription.items.data.length !== 1 ||
    subscription.status !== "active"
  ) {
    return "not-active";
  }
  const currentOffer = await resolveSubscriptionOffer(plan, stripe, subscription, {
    ownershipVerified: true,
  });
  if (!currentOffer) {
    return "not-active";
  }
  if (currentOffer.id === newOffer.id) {
    return "unchanged";
  }
  if (canChange && !(await canChange(currentOffer.tier, tier))) {
    return "blocked";
  }

  const item = subscription.items.data[0];
  let updated: Stripe.Subscription;
  try {
    updated = await stripe.subscriptions.update(
      subscription.id,
      {
        items: [{ id: item.id, price: newOffer.stripePriceId, quantity: 1 }],
        proration_behavior: "always_invoice",
        payment_behavior: "error_if_incomplete",
        metadata: {
          ...stripeOwnerMetadata(userId),
          planId: plan.id,
          billingOfferId: newOffer.id,
          tier,
        },
      },
      {
        // A deterministic key would replay a cached response for A→B→A→B
        // within Stripe's retention window and apply nothing; the price check
        // below is what guarantees the change actually landed.
        idempotencyKey: `${plan.id}-tier-change:${subscription.id}:${item.price.id}:${newOffer.stripePriceId}:${crypto.randomUUID()}`,
      },
    );
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      error.statusCode === 402
    ) {
      return "payment-failed";
    }
    throw error;
  }
  if (updated.items.data[0]?.price.id !== newOffer.stripePriceId) {
    throw new Error(
      `Subscription ${subscription.id} did not switch to ${newOffer.stripePriceId}`,
    );
  }

  // Same watermark trick as the portal-return sync: reuse the stored event
  // time so a webhook that already arrived is never overwritten, and advance
  // only the canonical observation time.
  await reconcileSubscriptionObservation({
    userId,
    stripeSubscriptionId: updated.id,
    status: updated.status,
    planId: plan.id,
    tier,
    billingOfferId: newOffer.id,
    ...getSubscriptionPeriod(updated),
    cancelAtPeriodEnd: isCancellationScheduled(updated),
    cancelAt: getScheduledCancellationTime(updated),
    stripeSubscriptionCreatedAt: updated.created
      ? new Date(updated.created * 1000)
      : null,
    stripeEventId: `tier-change:${updated.id}:${newOffer.stripePriceId}`,
    stripeEventCreatedAt: stored.stripeEventCreatedAt ?? new Date(0),
    stripeCanonicalObservedAt: new Date(),
    replaceExistingSubscription: false,
  });
  return "changed";
}

// Deep-link into the portal's cancellation flow for one plan's subscription.
// The target is the stored row's subscription, never a client-supplied id.
export async function createSubscriptionCancelPortalLink({
  stripe,
  plan,
  userId,
  customerId,
}: {
  stripe: ReturnType<typeof createStripe>;
  plan: SubscriptionPlanConfig;
  userId: string;
  customerId: string;
}): Promise<string | null> {
  const stored = await getSubscription({ userId, planId: plan.id });
  if (
    !stored ||
    stored.status === "canceled" ||
    stored.status === "incomplete_expired"
  ) {
    return null;
  }
  const configuration = await getSafeBillingPortalConfigurationId(stripe);
  const returnUrl = `${origin()}${BILLING_PATH}?portal=returned`;
  const portal = await stripe.billingPortal.sessions.create({
    customer: customerId,
    configuration,
    flow_data: {
      type: "subscription_cancel",
      subscription_cancel: { subscription: stored.stripeSubscriptionId },
      after_completion: {
        type: "redirect",
        redirect: { return_url: returnUrl },
      },
    },
    return_url: returnUrl,
  });
  return portal.url;
}
