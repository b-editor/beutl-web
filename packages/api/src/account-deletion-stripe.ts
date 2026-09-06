import Stripe from "stripe";
import { scheduleStripeCheckoutCleanup, setTopUpCheckoutSession } from "@beutl/db";

export type AdminStripeClosureResult =
  | { status: "not-linked" | "already-closed" | "closed"; customerId: string | null }
  | { status: "owner-mismatch" | "active-subscription"; customerId: string };

function isTerminalSubscription(status: Stripe.Subscription.Status): boolean {
  return status === "canceled" || status === "incomplete_expired";
}

function ownerMatches(metadata: Stripe.Metadata | null, userId: string): boolean {
  return (
    metadata?.beutlApplication === "beutl-web" &&
    metadata.beutlUserId === userId
  );
}

export async function closeStripeCustomerForAdminAccountDeletion({
  userId,
  stripeCustomerId,
  deletionAuthorizedAt,
  secretKey = process.env.STRIPE_SECRET_KEY,
  stripeClient,
}: {
  userId: string;
  stripeCustomerId?: string | null;
  deletionAuthorizedAt: Date;
  secretKey?: string;
  stripeClient?: Pick<Stripe, "customers" | "subscriptions" | "checkout" | "paymentIntents" | "charges">;
}): Promise<AdminStripeClosureResult> {
  if (!stripeCustomerId) return { status: "not-linked", customerId: null };
  if (!secretKey) throw new Error("Stripe secret key is not configured");
  const stripe = stripeClient ?? new Stripe(secretKey);
  let customer: Stripe.Customer | Stripe.DeletedCustomer;
  try {
    customer = await stripe.customers.retrieve(stripeCustomerId);
  } catch (error) {
    if (error instanceof Stripe.errors.StripeError && error.code === "resource_missing") {
      return { status: "already-closed", customerId: stripeCustomerId };
    }
    throw error;
  }
  if ("deleted" in customer && customer.deleted) {
    return { status: "already-closed", customerId: stripeCustomerId };
  }
  if (!ownerMatches(customer.metadata, userId)) {
    return { status: "owner-mismatch", customerId: stripeCustomerId };
  }

  let sessionCursor: string | undefined;
  for (;;) {
    const sessions = await stripe.checkout.sessions.list({ customer: stripeCustomerId, status: "open", limit: 100, ...(sessionCursor ? { starting_after: sessionCursor } : {}) });
    for (const session of sessions.data) {
      if (!ownerMatches(session.metadata, userId)) return { status: "owner-mismatch", customerId: stripeCustomerId };
      const isPackage = session.metadata?.beutlPurchaseKind === "package" && Boolean(session.metadata.packageId);
      const isTopUp = Boolean(session.metadata?.topUpAttemptId);
      const isPro = Boolean(session.metadata?.billingOfferId) && !isTopUp;
      if (isTopUp) { if (!session.metadata?.topUpAttemptId || (await setTopUpCheckoutSession({ attemptId: session.metadata.topUpAttemptId, stripeCheckoutSessionId: session.id, expiresAt: session.expires_at ? new Date(session.expires_at * 1000) : new Date() })) === "not-stored") return { status: "owner-mismatch", customerId: stripeCustomerId }; }
      else if (isPackage || isPro) await scheduleStripeCheckoutCleanup({ sessionId: session.id, userId, kind: isPackage ? "package" : "pro", customerId: stripeCustomerId, packageId: isPackage ? session.metadata?.packageId : null, billingOfferId: isPro ? session.metadata?.billingOfferId : null });
      else return { status: "owner-mismatch", customerId: stripeCustomerId };
      try { await stripe.checkout.sessions.expire(session.id); } catch (error) { const current = await stripe.checkout.sessions.retrieve(session.id); if (current.status !== "complete" && current.status !== "expired") throw error; }
    }
    if (!sessions.has_more) break;
    sessionCursor = sessions.data.at(-1)?.id;
    if (!sessionCursor) throw new Error("Stripe returned an empty Checkout page with has_more");
  }

  let completeCursor: string | undefined;
  for (;;) {
    const recentComplete = await stripe.checkout.sessions.list({ customer: stripeCustomerId, status: "complete", limit: 100, created: { gte: Math.max(0, Math.floor(deletionAuthorizedAt.getTime() / 1000) - 24 * 60 * 60 - 1) }, ...(completeCursor ? { starting_after: completeCursor } : {}) });
    for (const session of recentComplete.data) {
    if (!ownerMatches(session.metadata, userId)) return { status: "owner-mismatch", customerId: stripeCustomerId };
    const isPackage = session.metadata?.beutlPurchaseKind === "package" && Boolean(session.metadata.packageId);
    const isTopUp = Boolean(session.metadata?.topUpAttemptId);
    const isPro = Boolean(session.metadata?.billingOfferId) && !isTopUp;
    if (isTopUp || isPackage) {
      const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
      if (!paymentIntentId) return { status: "owner-mismatch", customerId: stripeCustomerId };
      let paymentIntent: Stripe.PaymentIntent;
      try { paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId); } catch { return { status: "owner-mismatch", customerId: stripeCustomerId }; }
      let charge: Stripe.Charge | null;
      try { charge = typeof paymentIntent.latest_charge === "object" ? paymentIntent.latest_charge : paymentIntent.latest_charge ? await stripe.charges.retrieve(paymentIntent.latest_charge) : null; } catch { return { status: "owner-mismatch", customerId: stripeCustomerId }; }
      if (!charge) return { status: "owner-mismatch", customerId: stripeCustomerId };
      if (charge.created * 1000 < deletionAuthorizedAt.getTime()) continue;
      if (isTopUp) { if (!session.metadata?.topUpAttemptId || (await setTopUpCheckoutSession({ attemptId: session.metadata.topUpAttemptId, stripeCheckoutSessionId: session.id, expiresAt: session.expires_at ? new Date(session.expires_at * 1000) : new Date() })) === "not-stored") return { status: "owner-mismatch", customerId: stripeCustomerId }; }
      else await scheduleStripeCheckoutCleanup({ sessionId: session.id, userId, kind: "package", customerId: stripeCustomerId, packageId: session.metadata?.packageId, billingOfferId: null });
    } else if (isPro) {
      const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
      if (!subscriptionId) return { status: "owner-mismatch", customerId: stripeCustomerId };
      let subscription: Stripe.Subscription;
      try { subscription = await stripe.subscriptions.retrieve(subscriptionId); } catch { return { status: "owner-mismatch", customerId: stripeCustomerId }; }
      if (subscription.created * 1000 < deletionAuthorizedAt.getTime()) continue;
      await scheduleStripeCheckoutCleanup({ sessionId: session.id, userId, kind: "pro", customerId: stripeCustomerId, packageId: null, billingOfferId: session.metadata?.billingOfferId });
    }
    else return { status: "owner-mismatch", customerId: stripeCustomerId };
    }
    if (!recentComplete.has_more) break;
    completeCursor = recentComplete.data.at(-1)?.id;
    if (!completeCursor) throw new Error("Stripe returned an empty completed Checkout page with has_more");
  }

  let subscriptionCursor: string | undefined;
  for (;;) {
    const subscriptions = await stripe.subscriptions.list({ customer: stripeCustomerId, status: "all", limit: 100, ...(subscriptionCursor ? { starting_after: subscriptionCursor } : {}) });
    for (const subscription of subscriptions.data) if (!isTerminalSubscription(subscription.status)) return { status: "active-subscription", customerId: stripeCustomerId };
    if (!subscriptions.has_more) break;
    subscriptionCursor = subscriptions.data.at(-1)?.id;
    if (!subscriptionCursor) throw new Error("Stripe returned an empty subscription page with has_more");
  }
  const finalOpen = await stripe.checkout.sessions.list({ customer: stripeCustomerId, status: "open", limit: 100 });
  if (finalOpen.data.length > 0 || finalOpen.has_more) return { status: "owner-mismatch", customerId: stripeCustomerId };
  await stripe.customers.del(stripeCustomerId, {}, {
    idempotencyKey: `beutl:admin-account-delete:customer:${stripeCustomerId}`,
  });
  return { status: "closed", customerId: stripeCustomerId };
}
