"use server";

import { throwIfUnauth } from "@/lib/auth-guard";
import { createOrRetrieveOwnedCustomerId } from "@/lib/customer";
import {
  getScheduledCancellationTime,
  isCancellationScheduled,
} from "@/lib/stripe/cancellation";
import {
  activateConfiguredProOffer,
  activateConfiguredTopUpOffer,
  blocksNewProCheckout,
  configuredProPriceIds,
  fulfillOrRefundTopUpPayment,
  getSubscriptionPeriod,
  resolveProBillingOffer,
} from "@/lib/stripe/ai-billing";
import { createStripe } from "@/lib/stripe/config";
import {
  getStripeCustomerOwnershipProof,
  hasStripeOwnerMetadata,
  stripeOwnerMetadata,
} from "@/lib/stripe/ownership";
import {
  discoverTopUpCheckoutAttempt,
  isActiveProSubscription,
  PRO_PLAN,
} from "@beutl/api";
import {
  allowsStripePromotionCodes,
  isValidStripeCheckoutSessionAmount,
  isZeroCostStripeCheckoutSessionAmount,
} from "@beutl/core";
import {
  bindTopUpCheckoutCreation,
  bindProCheckoutSession,
  claimTopUpCheckoutCreation,
  deleteBoundProCheckoutAttempt,
  expireTopUpCheckoutAttempt,
  findBillingOfferById,
  findCustomerByUserId,
  findProCheckoutAttemptBySessionId,
  findStripeCustomerOwnershipByStripeId,
  findTopUpCheckoutAttemptBySessionId,
  getOrCreateTopUpCheckoutAttempt,
  getOrCreateProCheckoutAttempt,
  getSubscriptionByUserId,
  reconcileSubscriptionObservation,
  recordBillingRefundCancellation,
  releaseTopUpCheckoutCreation,
  requireTopUpRefund,
  scheduleBillingRefundAttempt,
  setProCheckoutAttemptParams,
  startRetryableTransaction,
} from "@beutl/db";
import { redirect } from "next/navigation";
import type Stripe from "stripe";

function expandableId(
  value: string | { id: string } | null | undefined,
): string | null {
  return typeof value === "string" ? value : value?.id ?? null;
}

type PersistedBillingOffer = Pick<
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
>;

function checkoutSessionMatchesOffer(
  checkoutSession: Stripe.Checkout.Session,
  billingOffer: PersistedBillingOffer,
): boolean {
  const lineItems = checkoutSession.line_items?.data;
  return (
    billingOffer.kind === "pro" &&
    lineItems?.length === 1 &&
    lineItems[0].quantity === 1 &&
    expandableId(lineItems[0].price) === billingOffer.stripePriceId
  );
}

function subscriptionMatchesOffer(
  subscription: Stripe.Subscription,
  billingOffer: PersistedBillingOffer,
): boolean {
  if (
    billingOffer.kind !== "pro" ||
    subscription.metadata?.planId !== PRO_PLAN.id ||
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

function canonicalizeCheckoutParams(value: unknown): unknown {
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

async function expireOpenCheckoutSession(
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

function persistedProCheckoutParams(
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

async function compensateSupersededProCheckout({
  stripe,
  checkoutSession,
  subscription,
  billingOffer,
  expectedCustomerId,
  expectedUserId,
}: {
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
    checkoutSession.metadata?.planId !== PRO_PLAN.id ||
    checkoutSession.metadata?.billingOfferId !== billingOffer.id ||
    !hasStripeOwnerMetadata(checkoutSession.metadata, expectedUserId) ||
    expandableId(subscription.customer) !== expectedCustomerId ||
    !hasStripeOwnerMetadata(subscription.metadata, expectedUserId) ||
    !subscriptionMatchesOffer(subscription, billingOffer)
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
          disposition: "superseded-pro-checkout",
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
            `beutl:superseded-pro-checkout-cancel:${checkoutSession.id}`,
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

function proCheckoutSessionMatchesBinding({
  checkoutSession,
  stripeCheckoutSessionId,
  billingOffer,
  expectedCustomerId,
  expectedUserId,
}: {
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
    checkoutSession.metadata?.planId === PRO_PLAN.id &&
    checkoutSession.metadata?.billingOfferId === billingOffer.id &&
    hasStripeOwnerMetadata(checkoutSession.metadata, expectedUserId) &&
    checkoutSessionMatchesOffer(checkoutSession, billingOffer)
  );
}

async function resolveRejectedProCheckoutSession({
  stripe,
  stripeCheckoutSessionId,
  billingOffer,
  expectedCustomerId,
  expectedUserId,
}: {
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
    !proCheckoutSessionMatchesBinding({
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
    !proCheckoutSessionMatchesBinding({
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
    !proCheckoutSessionMatchesBinding({
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
  return await compensateSupersededProCheckout({
    stripe,
    checkoutSession,
    subscription,
    billingOffer,
    expectedCustomerId,
    expectedUserId,
  });
}

async function hasActiveProSubscription(userId: string): Promise<boolean> {
  const subscription = await getSubscriptionByUserId({ userId });
  return isActiveProSubscription(subscription);
}

async function getSafeBillingPortalConfigurationId(
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

async function hasBlockingStripeSubscription(
  stripe: ReturnType<typeof createStripe>,
  customerId: string,
  recognizedProPriceIds: ReadonlySet<string>,
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
      subscriptions.data.some((item) =>
        blocksNewProCheckout(item, recognizedProPriceIds),
      )
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

// Create a Checkout Session for the Pro subscription.
// Configure the price through STRIPE_PRO_PRICE_ID.
export async function createProCheckout(): Promise<void> {
  const session = await throwIfUnauth();
  const stripe = createStripe();
  const offer = await activateConfiguredProOffer(stripe);
  const recognizedProPriceIds = configuredProPriceIds();
  const customerId = await createOrRetrieveOwnedCustomerId({
    email: session.user.email as string,
    userId: session.user.id,
  });
  // Stripe is the source of truth for whether a subscription still blocks a new
  // checkout. A refund can cancel the subscription in Stripe while the local row
  // keeps its last non-terminal status, and trusting that row would leave the
  // user unable to resubscribe until the stored period finally elapsed.
  if (
    await hasBlockingStripeSubscription(
      stripe,
      customerId,
      recognizedProPriceIds,
    )
  ) {
    redirect("/dashboard/account/billing");
  }

  const origin = process.env.PUBLIC_ORIGIN || "https://beutl.beditor.net";
  const proCheckoutParams: Stripe.Checkout.SessionCreateParams = {
    customer: customerId,
    mode: "subscription",
    allow_promotion_codes: true,
    line_items: [{ price: offer.stripePriceId, quantity: 1 }],
    metadata: { ...stripeOwnerMetadata(session.user.id), planId: PRO_PLAN.id, billingOfferId: offer.id },
    subscription_data: { metadata: { ...stripeOwnerMetadata(session.user.id), planId: PRO_PLAN.id, billingOfferId: offer.id } },
    success_url: `${origin}/dashboard/account/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/dashboard/account/billing`,
  };
  for (let attemptNumber = 0; attemptNumber < 2; attemptNumber++) {
    const now = new Date();
    const attempt = await getOrCreateProCheckoutAttempt({
      userId: session.user.id,
      billingOfferId: offer.id,
      now,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      customerId,
      paramsJson: JSON.stringify(proCheckoutParams),
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
        candidate.metadata?.planId === PRO_PLAN.id &&
        candidate.metadata?.billingOfferId === attempt.billingOfferId &&
        hasStripeOwnerMetadata(candidate.metadata, session.user.id) &&
        checkoutSessionMatchesOffer(candidate, attemptOffer);
      const authorizedOffer =
        attemptOffer?.kind === "pro" &&
        recognizedProPriceIds.has(attemptOffer.stripePriceId);
      const promotionCodesEnabled = allowsStripePromotionCodes(
        attempt.paramsJson,
      );
      if (!isValidatedBoundSession(existingSession)) {
        if (
          existingSession.id === attempt.stripeCheckoutSessionId &&
          existingSession.status === "expired"
        ) {
          await deleteBoundProCheckoutAttempt({
            userId: session.user.id,
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
          `/dashboard/account/billing?checkout=success&session_id=${existingSession.id}`,
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
          `/dashboard/account/billing?checkout=success&session_id=${finalSession.id}`,
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
        const cancellationConfirmed = await compensateSupersededProCheckout({
          stripe,
          checkoutSession: finalSession,
          subscription,
          billingOffer: attemptOffer,
          expectedCustomerId: customerId,
          expectedUserId: session.user.id,
        });
        if (!cancellationConfirmed) {
          redirect("/dashboard/account/billing");
        }
        await deleteBoundProCheckoutAttempt({
          userId: session.user.id,
          checkoutKey: attempt.checkoutKey,
          stripeCheckoutSessionId: attempt.stripeCheckoutSessionId,
        });
        continue;
      }
      if (finalSession.status === "expired") {
        await deleteBoundProCheckoutAttempt({
          userId: session.user.id,
          checkoutKey: attempt.checkoutKey,
          stripeCheckoutSessionId: attempt.stripeCheckoutSessionId,
        });
        continue;
      }
      throw new Error(
        `Checkout Session ${attempt.stripeCheckoutSessionId} remains ${finalSession.status ?? "unknown"}`,
      );
    }

    let createParams = proCheckoutParams;
    if (attempt.paramsJson) {
      // Preserve the exact parameters attached to this idempotency key. An
      // attempt started before promotion codes were enabled may already exist
      // at Stripe even when its create response never reached this process.
      createParams = persistedProCheckoutParams(
        attempt.paramsJson,
        proCheckoutParams,
      );
    } else {
      const persisted = await setProCheckoutAttemptParams({
        userId: session.user.id,
        checkoutKey: attempt.checkoutKey,
        paramsJson: JSON.stringify(proCheckoutParams),
      });
      if (persisted.count !== 1) {
        continue;
      }
    }
    const checkoutSession = await stripe.checkout.sessions.create(
      createParams,
      {
        idempotencyKey: `ai-pro-checkout:${attempt.checkoutKey}`,
      },
    );
    const binding = await bindProCheckoutSession({
      userId: session.user.id,
      checkoutKey: attempt.checkoutKey,
      stripeCheckoutSessionId: checkoutSession.id,
      expiresAt: checkoutSession.expires_at
        ? new Date(checkoutSession.expires_at * 1000)
        : attempt.expiresAt,
    });
    if (binding === "account-deletion-authorized") {
      const cancellationConfirmed = await resolveRejectedProCheckoutSession({
        stripe,
        stripeCheckoutSessionId: checkoutSession.id,
        billingOffer: offer,
        expectedCustomerId: customerId,
        expectedUserId: session.user.id,
      });
      if (!cancellationConfirmed) {
        redirect("/dashboard/account/billing");
      }
      await deleteBoundProCheckoutAttempt({
        userId: session.user.id,
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
        const cancellationConfirmed = await compensateSupersededProCheckout({
          stripe,
          checkoutSession: finalSession,
          subscription,
          billingOffer: offer,
          expectedCustomerId: customerId,
          expectedUserId: session.user.id,
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
          `/dashboard/account/billing?checkout=success&session_id=${finalSession.id}`,
        );
      }
      if (finalSession.status === "expired") {
        await deleteBoundProCheckoutAttempt({
          userId: session.user.id,
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

const TOP_UP_CHECKOUT_RETENTION_MS = 24 * 60 * 60_000;
const TOP_UP_CHECKOUT_CREATE_LEASE_MS = 2 * 60_000;

function buildTopUpCheckoutParams({
  attemptId,
  customerId,
  offer,
  userId,
}: {
  attemptId: string;
  customerId: string;
  offer: PersistedBillingOffer;
  userId: string;
}): Stripe.Checkout.SessionCreateParams {
  return {
    customer: customerId,
    mode: "payment",
    allow_promotion_codes: true,
    line_items: [{ price: offer.stripePriceId, quantity: 1 }],
    metadata: {
      ...stripeOwnerMetadata(userId),
      creditAmount: String(offer.creditAmount),
      billingOfferId: offer.id,
      topUpAttemptId: attemptId,
    },
    payment_intent_data: {
      metadata: {
        ...stripeOwnerMetadata(userId),
        creditAmount: String(offer.creditAmount),
        billingOfferId: offer.id,
        topUpAttemptId: attemptId,
      },
    },
    invoice_creation: { enabled: true },
    success_url: `${process.env.PUBLIC_ORIGIN || "https://beutl.beditor.net"}/dashboard/account/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.PUBLIC_ORIGIN || "https://beutl.beditor.net"}/dashboard/account/billing`,
  };
}

function topUpParamsMatchAttempt({
  params,
  attemptId,
  customerId,
  offer,
  userId,
}: {
  params: Stripe.Checkout.SessionCreateParams;
  attemptId: string;
  customerId: string;
  offer: PersistedBillingOffer;
  userId: string;
}): boolean {
  const line = params.line_items?.[0];
  return params.mode === "payment" &&
    params.customer === customerId &&
    params.line_items?.length === 1 &&
    line?.quantity === 1 &&
    line !== undefined && "price" in line && line.price === offer.stripePriceId &&
    params.metadata?.beutlApplication === "beutl-web" &&
    params.metadata?.beutlUserId === userId &&
    params.metadata?.topUpAttemptId === attemptId &&
    params.metadata?.billingOfferId === offer.id &&
    params.metadata?.creditAmount === String(offer.creditAmount) &&
    params.payment_intent_data?.metadata?.beutlUserId === userId &&
    params.payment_intent_data.metadata.topUpAttemptId === attemptId &&
    params.payment_intent_data.metadata.billingOfferId === offer.id &&
    params.payment_intent_data.metadata.creditAmount ===
      String(offer.creditAmount);
}

type TopUpSessionIdentityExpectation = {
  checkoutSession: Stripe.Checkout.Session;
  attemptId: string;
  customerId: string;
  offer: PersistedBillingOffer;
  userId: string;
  requireLineItems: boolean;
};

function topUpSessionIdentityMatches({
  checkoutSession,
  attemptId,
  customerId,
  offer,
  userId,
  requireLineItems,
}: TopUpSessionIdentityExpectation): boolean {
  const lines = checkoutSession.line_items?.data;
  const lineMatches = lines === undefined
    ? !requireLineItems
    : lines.length === 1 && lines[0]?.quantity === 1 &&
      expandableId(lines[0].price) === offer.stripePriceId;
  return offer.kind === "top_up" &&
    checkoutSession.mode === "payment" &&
    expandableId(checkoutSession.customer) === customerId &&
    checkoutSession.metadata?.beutlApplication === "beutl-web" &&
    checkoutSession.metadata?.beutlUserId === userId &&
    checkoutSession.metadata?.topUpAttemptId === attemptId &&
    checkoutSession.metadata?.billingOfferId === offer.id &&
    checkoutSession.metadata?.creditAmount === String(offer.creditAmount) &&
    (checkoutSession.currency === null ||
      checkoutSession.currency.toLowerCase() === offer.currency.toLowerCase()) &&
    lineMatches;
}

function topUpSessionMatchesAttempt(
  expectation: TopUpSessionIdentityExpectation & {
    promotionCodesEnabled: boolean;
  },
): boolean {
  const { checkoutSession, offer, promotionCodesEnabled } = expectation;
  return topUpSessionIdentityMatches(expectation) &&
    isValidStripeCheckoutSessionAmount(
      {
        amountSubtotal: checkoutSession.amount_subtotal,
        amountTotal: checkoutSession.amount_total,
      },
      offer.unitAmount,
      promotionCodesEnabled,
      true,
    );
}

function isCompletedZeroCostTopUpSession(
  expectation: TopUpSessionIdentityExpectation & {
    promotionCodesEnabled: boolean;
  },
): boolean {
  const { checkoutSession, offer, promotionCodesEnabled } = expectation;
  return topUpSessionIdentityMatches(expectation) &&
    checkoutSession.status === "complete" &&
    (checkoutSession.payment_status === "paid" ||
      checkoutSession.payment_status === "no_payment_required") &&
    checkoutSession.payment_intent === null &&
    isZeroCostStripeCheckoutSessionAmount(
      {
        amountSubtotal: checkoutSession.amount_subtotal,
        amountTotal: checkoutSession.amount_total,
      },
      offer.unitAmount,
      promotionCodesEnabled,
    );
}

export async function createCreditCheckout(): Promise<void> {
  const authSession = await throwIfUnauth();
  if (!(await hasActiveProSubscription(authSession.user.id))) {
    redirect("/dashboard/account/billing");
  }
  const customerId = await createOrRetrieveOwnedCustomerId({
    email: authSession.user.email as string,
    userId: authSession.user.id,
  });
  const stripe = createStripe();
  const configuredOffer = await activateConfiguredTopUpOffer(stripe);

  for (let generation = 0; generation < 4; generation++) {
    const now = new Date();
    const proposedAttemptId = crypto.randomUUID();
    const proposedParams = buildTopUpCheckoutParams({
      attemptId: proposedAttemptId,
      customerId,
      offer: configuredOffer,
      userId: authSession.user.id,
    });
    const attempt = await getOrCreateTopUpCheckoutAttempt({
      proposedAttemptId,
      ownerUserId: authSession.user.id,
      stripeCustomerId: customerId,
      billingOfferId: configuredOffer.id,
      checkoutKey: `ai-top-up-checkout:${proposedAttemptId}`,
      paramsJson: JSON.stringify(proposedParams),
      expiresAt: new Date(now.getTime() + TOP_UP_CHECKOUT_RETENTION_MS),
      now,
    });
    if (attempt.stripeCustomerId !== customerId) {
      throw new Error("Unresolved top-up Checkout belongs to another Stripe Customer");
    }
    const offer = await findBillingOfferById({ id: attempt.billingOfferId });
    if (
      !offer ||
      offer.kind !== "top_up" ||
      !Number.isSafeInteger(offer.creditAmount) ||
      (offer.creditAmount ?? 0) <= 0
    ) {
      throw new Error("Unresolved top-up Checkout has an invalid billing offer");
    }

    if (attempt.stripeCheckoutSessionId) {
      const existing = await stripe.checkout.sessions.retrieve(
        attempt.stripeCheckoutSessionId,
        { expand: ["line_items.data.price"] },
      );
      const promotionCodesEnabled = allowsStripePromotionCodes(
        attempt.paramsJson,
      );
      const sessionExpectation = {
        checkoutSession: existing,
        attemptId: attempt.id,
        customerId: attempt.stripeCustomerId,
        offer,
        userId: authSession.user.id,
        requireLineItems: true,
        promotionCodesEnabled,
      };
      if (isCompletedZeroCostTopUpSession(sessionExpectation)) {
        const terminalized = await expireTopUpCheckoutAttempt({
          attemptId: attempt.id,
          ownerUserId: authSession.user.id,
          stripeCheckoutSessionId: existing.id,
        });
        if (terminalized.count !== 1) {
          throw new Error(
            "Zero-cost top-up Checkout changed during terminalization",
          );
        }
        continue;
      }
      if (!topUpSessionMatchesAttempt(sessionExpectation)) {
        throw new Error("Bound top-up Checkout failed canonical validation");
      }
      if (existing.status === "open" && !promotionCodesEnabled) {
        const finalSession = await expireOpenCheckoutSession(stripe, existing);
        if (finalSession.status === "complete") {
          if (!topUpSessionMatchesAttempt({
            ...sessionExpectation,
            checkoutSession: finalSession,
          })) {
            throw new Error(
              "Completed pre-promotion top-up Checkout failed canonical validation",
            );
          }
          redirect(
            `/dashboard/account/billing?checkout=success&session_id=${finalSession.id}`,
          );
        }
        if (finalSession.status !== "expired") {
          throw new Error(
            `Pre-promotion top-up Checkout ${existing.id} remains ${finalSession.status ?? "unknown"}`,
          );
        }
        const expired = await expireTopUpCheckoutAttempt({
          attemptId: attempt.id,
          ownerUserId: authSession.user.id,
          stripeCheckoutSessionId: existing.id,
        });
        if (expired.count !== 1) {
          throw new Error(
            "Pre-promotion top-up Checkout changed during rotation",
          );
        }
        continue;
      }
      if (existing.status === "expired") {
        const expired = await expireTopUpCheckoutAttempt({
          attemptId: attempt.id,
          ownerUserId: authSession.user.id,
          stripeCheckoutSessionId: existing.id,
        });
        if (expired.count !== 1) {
          throw new Error("Expired top-up Checkout changed during rotation");
        }
        continue;
      }
      if (existing.status === "open" && existing.url) redirect(existing.url);
      redirect("/dashboard/account/billing");
    }

    const leaseToken = crypto.randomUUID();
    const claim = await claimTopUpCheckoutCreation({
      attemptId: attempt.id,
      ownerUserId: authSession.user.id,
      now,
      leaseToken,
      leaseExpiresAt: new Date(now.getTime() + TOP_UP_CHECKOUT_CREATE_LEASE_MS),
    });
    if (claim.status === "busy") {
      await new Promise((resolve) =>
        setTimeout(resolve, 50 * (generation + 1)));
      continue;
    }

    try {
      if (!claim.attempt.paramsJson) {
        throw new Error("Unbound legacy top-up Checkout has no durable parameters");
      }
      const params = JSON.parse(
        claim.attempt.paramsJson,
      ) as Stripe.Checkout.SessionCreateParams;
      if (!topUpParamsMatchAttempt({
        params,
        attemptId: claim.attempt.id,
        customerId: claim.attempt.stripeCustomerId,
        offer,
        userId: authSession.user.id,
      })) {
        throw new Error("Persisted top-up Checkout parameters failed validation");
      }

      const discovery = await discoverTopUpCheckoutAttempt({
        stripe,
        customerId: claim.attempt.stripeCustomerId,
        userId: authSession.user.id,
        attemptId: claim.attempt.id,
        billingOfferId: claim.attempt.billingOfferId,
        createdAt: claim.attempt.createdAt,
      });
      if (discovery.status === "multiple") {
        throw new Error(
          `Multiple Stripe Checkout Sessions match top-up attempt ${claim.attempt.id}`,
        );
      }

      let checkoutSession: Stripe.Checkout.Session;
      if (discovery.status === "single") {
        checkoutSession = await stripe.checkout.sessions.retrieve(
          discovery.session.id,
          { expand: ["line_items.data.price"] },
        );
        const sessionExpectation = {
          checkoutSession,
          attemptId: claim.attempt.id,
          customerId: claim.attempt.stripeCustomerId,
          offer,
          userId: authSession.user.id,
          requireLineItems: true,
          promotionCodesEnabled: allowsStripePromotionCodes(params),
        };
        if (isCompletedZeroCostTopUpSession(sessionExpectation)) {
          const terminalized = await expireTopUpCheckoutAttempt({
            attemptId: claim.attempt.id,
            ownerUserId: authSession.user.id,
            stripeCheckoutSessionId: null,
            leaseToken,
          });
          if (terminalized.count !== 1) {
            throw new Error("Zero-cost top-up discovery lease was lost");
          }
          continue;
        }
        if (!topUpSessionMatchesAttempt(sessionExpectation)) {
          throw new Error("Discovered top-up Checkout failed canonical validation");
        }
      } else {
        if (now.getTime() - claim.attempt.createdAt.getTime() >=
          TOP_UP_CHECKOUT_RETENTION_MS) {
          const markerPrefix = `absence:${claim.attempt.id}:`;
          const previous = claim.attempt.recoveryLastError?.startsWith(
            markerPrefix,
          )
            ? Date.parse(claim.attempt.recoveryLastError.slice(markerPrefix.length))
            : Number.NaN;
          if (
            Number.isFinite(previous) &&
            now.getTime() - previous >= 5 * 60_000
          ) {
            const expired = await expireTopUpCheckoutAttempt({
              attemptId: claim.attempt.id,
              ownerUserId: authSession.user.id,
              stripeCheckoutSessionId: null,
              leaseToken,
            });
            if (expired.count !== 1) {
              throw new Error("Top-up Checkout absence rotation lease was lost");
            }
            continue;
          }
          const observedAt = Number.isFinite(previous)
            ? previous
            : now.getTime();
          await releaseTopUpCheckoutCreation({
            attemptId: claim.attempt.id,
            leaseToken,
            lastError: `${markerPrefix}${new Date(observedAt).toISOString()}`,
            notBefore: new Date(observedAt + 5 * 60_000),
          });
          redirect("/dashboard/account/billing");
        }
        checkoutSession = await stripe.checkout.sessions.create(params, {
          idempotencyKey: claim.attempt.checkoutKey,
          timeout: 20_000,
          maxNetworkRetries: 2,
        });
        const sessionExpectation = {
          checkoutSession,
          attemptId: claim.attempt.id,
          customerId: claim.attempt.stripeCustomerId,
          offer,
          userId: authSession.user.id,
          requireLineItems: false,
          promotionCodesEnabled: allowsStripePromotionCodes(params),
        };
        if (isCompletedZeroCostTopUpSession(sessionExpectation)) {
          const terminalized = await expireTopUpCheckoutAttempt({
            attemptId: claim.attempt.id,
            ownerUserId: authSession.user.id,
            stripeCheckoutSessionId: null,
            leaseToken,
          });
          if (terminalized.count !== 1) {
            throw new Error("Zero-cost top-up replay lease was lost");
          }
          continue;
        }
        if (!topUpSessionMatchesAttempt(sessionExpectation)) {
          throw new Error("Created top-up Checkout failed canonical validation");
        }
      }

      const promotionCodesEnabled = allowsStripePromotionCodes(params);
      if (checkoutSession.status === "open" && !promotionCodesEnabled) {
        const finalSession = await expireOpenCheckoutSession(
          stripe,
          checkoutSession,
        );
        if (finalSession.status === "expired") {
          const expired = await expireTopUpCheckoutAttempt({
            attemptId: claim.attempt.id,
            ownerUserId: authSession.user.id,
            stripeCheckoutSessionId: null,
            leaseToken,
          });
          if (expired.count !== 1) {
            throw new Error(
              "Pre-promotion top-up Checkout rotation lease was lost",
            );
          }
          continue;
        }
        if (
          finalSession.status !== "complete" ||
          !topUpSessionMatchesAttempt({
            checkoutSession: finalSession,
            attemptId: claim.attempt.id,
            customerId: claim.attempt.stripeCustomerId,
            offer,
            userId: authSession.user.id,
            requireLineItems: true,
            promotionCodesEnabled,
          })
        ) {
          throw new Error(
            "Completed pre-promotion top-up Checkout failed canonical validation",
          );
        }
        checkoutSession = finalSession;
      }

      if (checkoutSession.status === "expired") {
        const expired = await expireTopUpCheckoutAttempt({
          attemptId: claim.attempt.id,
          ownerUserId: authSession.user.id,
          stripeCheckoutSessionId: null,
          leaseToken,
        });
        if (expired.count !== 1) {
          throw new Error("Expired top-up Checkout creation lease was lost");
        }
        continue;
      }
      const stored = await bindTopUpCheckoutCreation({
        attemptId: claim.attempt.id,
        leaseToken,
        stripeCheckoutSessionId: checkoutSession.id,
        expiresAt: checkoutSession.expires_at
          ? new Date(checkoutSession.expires_at * 1_000)
          : claim.attempt.expiresAt,
      });
      if (stored !== "stored-for-checkout") {
        redirect("/dashboard/account/billing");
      }
      if (checkoutSession.status === "open" && checkoutSession.url) {
        redirect(checkoutSession.url);
      }
      if (checkoutSession.status === "complete") {
        redirect(
          `/dashboard/account/billing?checkout=success&session_id=${checkoutSession.id}`,
        );
      }
      redirect("/dashboard/account/billing");
    } catch (error) {
      await releaseTopUpCheckoutCreation({
        attemptId: claim.attempt.id,
        leaseToken,
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  throw new Error("Top-up Checkout creation is still in progress");
}

export async function reconcileAiCheckoutSuccess(
  stripeCheckoutSessionId: string,
): Promise<boolean> {
  const authSession = await throwIfUnauth();
  if (!stripeCheckoutSessionId.startsWith("cs_")) {
    return false;
  }
  const stripe = createStripe();
  let checkoutSession: Stripe.Checkout.Session;
  try {
    checkoutSession = await stripe.checkout.sessions.retrieve(
      stripeCheckoutSessionId,
    );
  } catch {
    // The success URL is user-controlled. An expired, forged, or inaccessible
    // session must not prevent the account page from rendering.
    return false;
  }
  const customerId =
    typeof checkoutSession.customer === "string"
      ? checkoutSession.customer
      : checkoutSession.customer?.id;
  if (
    checkoutSession.id !== stripeCheckoutSessionId ||
    checkoutSession.status !== "complete" ||
    !customerId ||
    !hasStripeOwnerMetadata(checkoutSession.metadata, authSession.user.id)
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
      userId: authSession.user.id,
    }) === "mismatch"
  ) {
    return false;
  }
  const currentCustomer = await findCustomerByUserId({
    userId: authSession.user.id,
  });
  const usesCurrentCustomer = currentCustomer?.stripeId === customerId;

  if (checkoutSession.mode === "subscription") {
    if (
      checkoutSession.payment_status !== "paid" &&
      checkoutSession.payment_status !== "no_payment_required"
    ) {
      return false;
    }
    const subscriptionId =
      typeof checkoutSession.subscription === "string"
        ? checkoutSession.subscription
        : checkoutSession.subscription?.id;
    if (!subscriptionId) {
      return false;
    }
    const [subscription, attempt, stored] = await Promise.all([
      stripe.subscriptions.retrieve(subscriptionId),
      findProCheckoutAttemptBySessionId({
        userId: authSession.user.id,
        stripeCheckoutSessionId,
      }),
      getSubscriptionByUserId({ userId: authSession.user.id }),
    ]);
    const subscriptionCustomerId =
      typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer?.id;
    if (
      !Number.isSafeInteger(subscription.created) ||
      subscription.created < 0
    ) {
      return false;
    }
    const subscriptionCreatedAt = new Date(subscription.created * 1_000);
    if (
      subscriptionCustomerId !== customerId ||
      !hasStripeOwnerMetadata(subscription.metadata, authSession.user.id)
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
        checkoutSession.mode !== "subscription" ||
        checkoutSession.metadata?.planId !== PRO_PLAN.id ||
        checkoutSession.metadata?.billingOfferId !== attempt.billingOfferId ||
        !subscriptionMatchesOffer(subscription, attemptOffer)
      ) {
        return false;
      }
      if (!configuredProPriceIds().has(attemptOffer.stripePriceId)) {
        const cancellationConfirmed = await compensateSupersededProCheckout({
          stripe,
          checkoutSession,
          subscription,
          billingOffer: attemptOffer,
          expectedCustomerId: customerId,
          expectedUserId: authSession.user.id,
        });
        if (cancellationConfirmed) {
          await deleteBoundProCheckoutAttempt({
            userId: authSession.user.id,
            checkoutKey: attempt.checkoutKey,
            stripeCheckoutSessionId,
          });
        }
        return false;
      }
    }
    const offer = await resolveProBillingOffer(stripe, subscription, {
      ownershipVerified: true,
    });
    if (
      !offer ||
      checkoutSession.metadata?.billingOfferId !== offer.id
    ) {
      return false;
    }
    if (attempt && attempt.billingOfferId !== offer.id) {
      return false;
    }
    if (!usesCurrentCustomer) {
      const cancellationConfirmed = await compensateSupersededProCheckout({
        stripe,
        checkoutSession,
        subscription,
        billingOffer: offer,
        expectedCustomerId: customerId,
        expectedUserId: authSession.user.id,
      });
      if (cancellationConfirmed && attempt) {
        await deleteBoundProCheckoutAttempt({
          userId: authSession.user.id,
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
      userId: authSession.user.id,
      stripeSubscriptionId: subscription.id,
      status: subscription.status,
      planId: PRO_PLAN.id,
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
    if (
      reconciliation.subscription?.stripeSubscriptionId !== subscription.id
    ) {
      return false;
    }
    if (attempt) {
      await deleteBoundProCheckoutAttempt({
        userId: authSession.user.id,
        checkoutKey: attempt.checkoutKey,
        stripeCheckoutSessionId,
      });
    }
    return true;
  }

  if (checkoutSession.mode === "payment") {
    const attempt = await findTopUpCheckoutAttemptBySessionId({
      stripeCheckoutSessionId,
    });
    if (
      !attempt ||
      attempt.ownerUserId !== authSession.user.id ||
      attempt.stripeCustomerId !== customerId ||
      checkoutSession.metadata?.topUpAttemptId !== attempt.id ||
      checkoutSession.metadata?.billingOfferId !== attempt.billingOfferId
    ) {
      return false;
    }
    const offer = await findBillingOfferById({ id: attempt.billingOfferId });
    if (!offer || offer.kind !== "top_up") {
      return false;
    }
    if (isCompletedZeroCostTopUpSession({
      checkoutSession,
      attemptId: attempt.id,
      customerId: attempt.stripeCustomerId,
      offer,
      userId: authSession.user.id,
      requireLineItems: false,
      promotionCodesEnabled: allowsStripePromotionCodes(attempt.paramsJson),
    })) {
      await expireTopUpCheckoutAttempt({
        attemptId: attempt.id,
        ownerUserId: authSession.user.id,
        stripeCheckoutSessionId,
      });
      return false;
    }
    if (checkoutSession.payment_status !== "paid") {
      return false;
    }
    const paymentIntentId =
      typeof checkoutSession.payment_intent === "string"
        ? checkoutSession.payment_intent
        : checkoutSession.payment_intent?.id;
    if (!paymentIntentId) {
      return false;
    }
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (!usesCurrentCustomer) {
      await requireTopUpRefund({
        attemptId: attempt.id,
        stripePaymentIntentId: paymentIntentId,
      });
      await fulfillOrRefundTopUpPayment(stripe, paymentIntent);
      return false;
    }
    const result = await fulfillOrRefundTopUpPayment(stripe, paymentIntent);
    return (
      result.status === "fulfilled" || result.status === "already-fulfilled"
    );
  }
  return false;
}

// Deep-link into the portal's payment method update flow. Kept separate from
// createBillingPortalLink so the flow is fixed on the server rather than chosen
// by a form field, and so each flow's Stripe call shape is pinned by its own test.
export async function createPaymentMethodPortalLink(): Promise<void> {
  const session = await throwIfUnauth();
  const customerId = await createOrRetrieveOwnedCustomerId({
    email: session.user.email as string,
    userId: session.user.id,
  });
  const stripe = createStripe();
  const configuration = await getSafeBillingPortalConfigurationId(stripe, {
    requirePaymentMethodUpdate: true,
  });
  const returnUrl = `${process.env.PUBLIC_ORIGIN || "https://beutl.beditor.net"}/dashboard/account/billing?portal=returned`;
  const portal = await stripe.billingPortal.sessions.create({
    customer: customerId,
    configuration,
    flow_data: {
      type: "payment_method_update",
      after_completion: {
        type: "redirect",
        redirect: { return_url: returnUrl },
      },
    },
    return_url: returnUrl,
  });

  redirect(portal.url);
}

// Create a Stripe Customer Portal link for cancellations and billing management.
export async function createBillingPortalLink(): Promise<void> {
  const session = await throwIfUnauth();
  const customerId = await createOrRetrieveOwnedCustomerId({
    email: session.user.email as string,
    userId: session.user.id,
  });
  const stripe = createStripe();
  const configuration = await getSafeBillingPortalConfigurationId(stripe);
  const portal = await stripe.billingPortal.sessions.create({
    customer: customerId,
    configuration,
    // Mark the return trip so the page can pull the current subscription state
    // instead of waiting for the cancellation webhook to arrive.
    return_url: `${process.env.PUBLIC_ORIGIN || "https://beutl.beditor.net"}/dashboard/account/billing?portal=returned`,
  });

  redirect(portal.url);
}
