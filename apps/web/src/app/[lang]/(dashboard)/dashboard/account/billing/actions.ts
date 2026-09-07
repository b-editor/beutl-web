"use server";

import { throwIfUnauth } from "@/lib/auth-guard";
import { createOrRetrieveOwnedCustomerId } from "@/lib/customer";
import {
  activateConfiguredTopUpOffer,
  fulfillOrRefundTopUpPayment,
} from "@/lib/stripe/ai-billing";
import { createStripe } from "@/lib/stripe/config";
import {
  getStripeCustomerOwnershipProof,
  hasStripeOwnerMetadata,
  stripeOwnerMetadata,
} from "@/lib/stripe/ownership";
import {
  createSubscriptionCheckout,
  expireOpenCheckoutSession,
  getSafeBillingPortalConfigurationId,
  reconcileSubscriptionCheckoutSuccess,
  type PersistedBillingOffer,
} from "@/lib/stripe/subscription-checkout";
import {
  subscriptionPlanConfig,
  subscriptionPlanConfigOf,
} from "@/lib/stripe/subscription-plans";
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
  claimTopUpCheckoutCreation,
  expireTopUpCheckoutAttempt,
  findBillingOfferById,
  findCustomerByUserId,
  findStripeCustomerOwnershipByStripeId,
  findTopUpCheckoutAttemptBySessionId,
  getOrCreateTopUpCheckoutAttempt,
  getSubscription,
  releaseTopUpCheckoutCreation,
  requireTopUpRefund,
} from "@beutl/db";
import { redirect } from "next/navigation";
import type Stripe from "stripe";

function expandableId(
  value: string | { id: string } | null | undefined,
): string | null {
  return typeof value === "string" ? value : value?.id ?? null;
}


async function hasActiveProSubscription(userId: string): Promise<boolean> {
  const subscription = await getSubscription({ userId, planId: PRO_PLAN.id });
  return isActiveProSubscription(subscription);
}

// Create a Checkout Session for the Pro subscription.
// Configure the price through STRIPE_PRO_PRICE_ID.
export async function createProCheckout(): Promise<void> {
  const session = await throwIfUnauth();
  const customerId = await createOrRetrieveOwnedCustomerId({
    email: session.user.email as string,
    userId: session.user.id,
  });
  await createSubscriptionCheckout({
    stripe: createStripe(),
    plan: subscriptionPlanConfig("pro"),
    tier: null,
    userId: session.user.id,
    customerId,
  });
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
    // The plan is whatever the Session was created for; a Session without a
    // recognized plan is read as AI Pro, which is how it was always read.
    return await reconcileSubscriptionCheckoutSuccess({
      stripe,
      plan:
        subscriptionPlanConfigOf(checkoutSession.metadata?.planId) ??
        subscriptionPlanConfig("pro"),
      userId: authSession.user.id,
      stripeCheckoutSessionId,
    });
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
