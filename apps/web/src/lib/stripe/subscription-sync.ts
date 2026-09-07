// Pulls the current state of a user's subscription for one plan on demand.
//
// Subscription state normally arrives through webhooks, but a cancellation made
// in the customer portal is only observable once `customer.subscription.updated`
// is delivered. Until then the account screens keep reporting an unchanged plan,
// so a user who just canceled cannot tell that it registered. Reading Stripe
// directly when the user returns from the portal closes that window.
import { getSubscriptionPeriod } from "./ai-billing";
import {
  getScheduledCancellationTime,
  isCancellationScheduled,
} from "./cancellation";
import { createStripe } from "./config";
import { isStripeResourceMissingError } from "./errors";
import {
  getExpandableId,
  getStripeCustomerOwnershipProof,
  type StripeCustomerOwnershipRecord,
} from "./ownership";
import { resolveSubscriptionOffer } from "./subscription-billing";
import { subscriptionPlanConfig } from "./subscription-plans";
import {
  findCustomerByUserId,
  getSubscription,
  reconcileSubscriptionObservation,
} from "@beutl/db";
import type { SubscriptionPlanId } from "@beutl/core";
import type Stripe from "stripe";

function syntheticEventId(subscriptionId: string): string {
  return `sync:${subscriptionId}`;
}

// Mirrors the webhook path: the subscription must belong to the mapped customer
// and that customer must be provably owned by this user.
function isOwnedByUser(
  subscription: Stripe.Subscription,
  customerId: string | null,
  userId: string,
  ownership: StripeCustomerOwnershipRecord | null | undefined,
): boolean {
  if (!customerId || getExpandableId(subscription.customer) !== customerId) {
    return false;
  }
  return getStripeCustomerOwnershipProof({
    customerId,
    metadata: subscription.metadata,
    ownership,
    userId,
  }) !== "mismatch";
}

// Reconciles the stored subscription of one plan with Stripe for a single
// user. Returns true when the local row changed, so the caller can decide
// whether to revalidate.
export async function syncSubscriptionFromStripe(
  userId: string,
  planId: SubscriptionPlanId = "pro",
): Promise<boolean> {
  const plan = subscriptionPlanConfig(planId);
  const stored = await getSubscription({ userId, planId: plan.id });
  if (!stored) {
    return false;
  }

  const customer = await findCustomerByUserId({ userId });
  if (!customer) {
    return false;
  }
  const stripe = createStripe();
  // Stamped before the read so two overlapping syncs rank by when they asked
  // Stripe, not by how long each took to get its answer persisted.
  const observedAt = new Date();
  let subscription: Stripe.Subscription;
  try {
    subscription = await stripe.subscriptions.retrieve(
      stored.stripeSubscriptionId,
    );
  } catch (error) {
    if (isStripeResourceMissingError(error)) {
      // Stripe only returns resource_missing after the subscription has been
      // removed. Persist the terminal state through the normal monotonic
      // observation path so the account page immediately offers a new
      // subscription instead of keeping a stale active row indefinitely.
      const result = await reconcileSubscriptionObservation({
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
        stripeEventId: `${syntheticEventId(stored.stripeSubscriptionId)}:missing`,
        stripeEventCreatedAt: stored.stripeEventCreatedAt ?? new Date(0),
        stripeCanonicalObservedAt: observedAt,
        // A portal read must never replace a different subscription that a
        // later webhook has already associated with this user.
        replaceExistingSubscription: false,
      });
      return result.applied;
    }
    throw error;
  }

  if (
    !isOwnedByUser(
      subscription,
      customer.stripeId,
      userId,
      customer.ownership,
    )
  ) {
    console.warn("Ignoring an unowned subscription during portal sync", {
      stripeSubscriptionId: subscription.id,
      userId,
    });
    return false;
  }

  const period = getSubscriptionPeriod(subscription);
  const cancelAtPeriodEnd = isCancellationScheduled(subscription);
  const cancelAt = getScheduledCancellationTime(subscription);
  const billingOffer = await resolveSubscriptionOffer(plan, stripe, subscription, {
    ownershipVerified: true,
  });
  const status = billingOffer ? subscription.status : "invalid_price";
  const tier = billingOffer ? billingOffer.tier : stored.tier;
  if (
    stored.status === status &&
    (stored.tier ?? null) === (tier ?? null) &&
    stored.cancelAtPeriodEnd === cancelAtPeriodEnd &&
    stored.cancelAt?.getTime() === cancelAt?.getTime() &&
    stored.currentPeriodStart?.getTime() ===
      period.currentPeriodStart?.getTime() &&
    stored.currentPeriodEnd?.getTime() === period.currentPeriodEnd?.getTime()
    && stored.billingOfferId === (billingOffer?.id ?? null)
  ) {
    return false;
  }

  // A canonical read has no Stripe event timestamp. Reuse the stored webhook
  // watermark and advance only canonicalObservedAt. This lets a later read
  // restore a resumed cancellation even when Stripe clears canceled_at, while
  // any subsequently delivered webhook still outranks the synthetic read.
  const eventTime = stored.stripeEventCreatedAt ?? new Date(0);
  const result = await reconcileSubscriptionObservation({
    userId,
    stripeSubscriptionId: subscription.id,
    status,
    planId: plan.id,
    tier,
    billingOfferId: billingOffer?.id ?? null,
    ...period,
    cancelAtPeriodEnd,
    cancelAt,
    stripeSubscriptionCreatedAt: subscription.created
      ? new Date(subscription.created * 1000)
      : null,
    stripeEventId: syntheticEventId(subscription.id),
    stripeEventCreatedAt: eventTime,
    stripeCanonicalObservedAt: observedAt,
    // Never let an on-demand read swap in a different subscription; only the
    // webhook path, which sees the full event ordering, may do that.
    replaceExistingSubscription: false,
  });
  return result.applied;
}
