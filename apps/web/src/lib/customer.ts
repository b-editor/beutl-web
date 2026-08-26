import {
  createVerifiedCustomerMappingIfAbsent,
  beginStripeCustomerProvisioning,
  findBillingOfferById,
  findBoundProCheckoutAttemptForAccountDeletion,
  findAccountDeletionIntentByUserId,
  inspectAccountDeletionBillingBlockers,
  countActiveStripeCustomerProvisioning,
  findCustomerByUserId,
  findStripeCustomerOwnershipByStripeId,
  markStripeCustomerOwnershipVerified,
  recordBillingRefundCancellation,
  replaceCustomerMappingWithVerifiedOwnership,
  recordStripeCustomerProvisioningRemote,
  scheduleStripeCustomerProvisioningCleanup,
  settleStripeCustomerProvisioning,
  updateStripeCustomerProvisioningKey,
  scheduleBillingRefundAttempt,
  scheduleStripeCheckoutCleanup,
  setTopUpCheckoutSession,
  startRetryableTransaction,
} from "@beutl/db";
import { PRO_PLAN } from "@beutl/api";
import { addAuditLog, auditLogActions } from "@beutl/next/audit-log";
import { isStripeResourceMissingError } from "@/lib/stripe/errors";
import { createStripe } from "@/lib/stripe/config";
import {
  getExpandableId,
  getStripeCustomerOwnershipProof,
  hasStripeOwnerMetadata,
  stripeOwnerMetadata,
  type StripeCustomerOwnershipRecord,
} from "@/lib/stripe/ownership";
import type Stripe from "stripe";

type StripeClient = ReturnType<typeof createStripe>;

export type CustomerEmailSyncResult =
  | { status: "not-linked" }
  | { status: "synced"; customerId: string }
  | { status: "customer-deleted"; customerId: string }
  | { status: "owner-mismatch"; customerId: string };

export type CustomerClosureResult =
  | { status: "not-linked" }
  | { status: "already-closed"; customerId: string }
  | { status: "closed"; customerId: string }
  | { status: "owner-mismatch"; customerId: string };

function isDeletedCustomer(
  customer: Stripe.Customer | Stripe.DeletedCustomer,
): customer is Stripe.DeletedCustomer {
  return "deleted" in customer && customer.deleted === true;
}

async function retrieveCustomerIfPresent(
  stripe: StripeClient,
  customerId: string,
): Promise<Stripe.Customer | null> {
  try {
    const customer = await stripe.customers.retrieve(customerId);
    return isDeletedCustomer(customer) ? null : customer;
  } catch (error) {
    if (isStripeResourceMissingError(error)) {
      return null;
    }
    throw error;
  }
}

async function createRecoverableCustomer({
  stripe,
  params,
  idempotencyKey,
  beforeCreate,
}: {
  stripe: StripeClient;
  params: Stripe.CustomerCreateParams;
  idempotencyKey: string;
  beforeCreate?: (idempotencyKey: string) => Promise<void>;
}): Promise<Stripe.Customer> {
  let nextIdempotencyKey = idempotencyKey;
  for (let recoveryAttempt = 0; recoveryAttempt < 8; recoveryAttempt++) {
    await beforeCreate?.(nextIdempotencyKey);
    const created = await stripe.customers.create(params, {
      idempotencyKey: nextIdempotencyKey,
    });
    const current = await retrieveCustomerIfPresent(stripe, created.id);
    if (current) return current;

    // Stripe can replay a successful create response for a finite period even
    // after compensation deleted that Customer. Chaining the deleted ID into
    // the next key is deterministic, so concurrent retries recover the same
    // live Customer without mapping the cached deleted object.
    nextIdempotencyKey = `beutl:customer-recovery:${created.id}`;
  }

  throw new Error("Stripe repeatedly returned deleted customer creations");
}

async function syncCustomerEmail(
  stripe: StripeClient,
  customerId: string,
  email: string,
): Promise<void> {
  await stripe.customers.update(customerId, {
    email,
  });
}

async function compensateUnmappedCustomer({
  stripe,
  customer,
  userId,
}: {
  stripe: StripeClient;
  customer: Stripe.Customer;
  userId: string;
}): Promise<void> {
  try {
    const mapping = await findCustomerByUserId({ userId });
    if (
      mapping?.stripeId === customer.id ||
      !hasStripeOwnerMetadata(customer.metadata, userId)
    ) {
      return;
    }
    await stripe.customers.del(
      customer.id,
      {},
      {
        idempotencyKey: `beutl:unmapped-customer-cleanup:${customer.id}`,
      },
    );
  } catch (cleanupError) {
    // Preserve the mapping failure as the primary error. The customer keeps
    // owner metadata, so operators can identify it if Stripe cleanup is down.
    console.error("Could not remove an unmapped Stripe customer", {
      cleanupError,
      stripeCustomerId: customer.id,
      userId,
    });
  }
}

// List subscriptions that still bill a Customer whose owner cannot be verified.
async function listActiveSubscriptionsOnCustomer(
  stripe: StripeClient,
  customerId: string,
): Promise<string[]> {
  const billing = new Set([
    "active",
    "trialing",
    "past_due",
    "unpaid",
    "incomplete",
    "paused",
  ]);
  let startingAfter: string | undefined;
  const left: string[] = [];
  for (;;) {
    let subscriptions;
    try {
      subscriptions = await stripe.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
    } catch (error) {
      if (isStripeResourceMissingError(error)) break;
      throw error;
    }
    for (const subscription of subscriptions.data) {
      if (billing.has(subscription.status)) left.push(subscription.id);
    }
    if (!subscriptions.has_more) break;
    const last = subscriptions.data.at(-1);
    if (!last) break;
    startingAfter = last.id;
  }
  return left;
}

async function expireOwnedOpenCheckoutSessions({
  stripe,
  customerId,
  userId,
}: {
  stripe: StripeClient;
  customerId: string;
  userId: string;
}): Promise<void> {
  // Scan every page before mutating Stripe. If a later page contains an
  // unowned legacy Session, no earlier Session may have been expired while we
  // were still deciding whether replacement was safe.
  const sessionsToExpire: Stripe.Checkout.Session[] = [];
  let startingAfter: string | undefined;
  for (;;) {
    const sessions = await stripe.checkout.sessions.list({
      customer: customerId,
      status: "open",
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const session of sessions.data) {
      if (!hasStripeOwnerMetadata(session.metadata, userId)) {
        // An unowned legacy Session is still payable. Moving the local mapping
        // would strand that payment under a Customer the user can no longer
        // reach, so refuse migration until an operator resolves it.
        throw new Error(
          `Cannot replace legacy Stripe customer ${customerId} while open Checkout Session ${session.id} has no verified owner`,
        );
      }
      sessionsToExpire.push(session);
    }
    if (!sessions.has_more) break;
    const lastSession = sessions.data.at(-1);
    if (!lastSession) {
      throw new Error("Stripe returned an empty Checkout page with has_more");
    }
    startingAfter = lastSession.id;
  }
  for (const session of sessionsToExpire) {
    try {
      await stripe.checkout.sessions.expire(session.id);
    } catch (error) {
      // The session may have completed between list and expire. Its success
      // replay performs the current-customer check and compensates it.
      if (!isStripeResourceMissingError(error)) throw error;
    }
  }
}

async function verifyCustomerOwnership({
  customer,
  ownership,
  userId,
}: {
  customer: Stripe.Customer;
  ownership: StripeCustomerOwnershipRecord | null | undefined;
  userId: string;
}) {
  const proof = getStripeCustomerOwnershipProof({
    customerId: customer.id,
    metadata: customer.metadata,
    ownership,
    userId,
  });
  if (proof === "stripe-metadata" && ownership?.verifiedAt === null) {
    await markStripeCustomerOwnershipVerified({
      userId,
      stripeId: customer.id,
    });
  }
  return proof;
}

export async function updateCustomerEmailIfExist({
  userId,
  email,
}: {
  userId: string;
  email: string;
}): Promise<CustomerEmailSyncResult> {
  const mapping = await findCustomerByUserId({ userId });
  if (!mapping) {
    return { status: "not-linked" };
  }

  const stripe = createStripe();
  const customer = await retrieveCustomerIfPresent(stripe, mapping.stripeId);
  if (!customer) {
    return {
      status: "customer-deleted",
      customerId: mapping.stripeId,
    };
  }
  const proof = await verifyCustomerOwnership({
    customer,
    ownership: mapping.ownership,
    userId,
  });
  if (proof === "mismatch") {
    return { status: "owner-mismatch", customerId: customer.id };
  }
  await syncCustomerEmail(stripe, customer.id, email);
  return { status: "synced", customerId: customer.id };
}

async function createOwnedCustomer({
  stripe,
  email,
  userId,
  replacesCustomerId,
}: {
  stripe: StripeClient;
  email: string;
  userId: string;
  replacesCustomerId?: string;
}): Promise<string> {
  const customerParams: Stripe.CustomerCreateParams = {
    metadata: stripeOwnerMetadata(userId),
  };
  const customerIdempotencyKey = replacesCustomerId
    ? `beutl:customer:${userId}:replace:${replacesCustomerId}`
    : `beutl:customer:${userId}`;
  const provisioningLeaseToken = crypto.randomUUID();
  const provisioningLeaseExpiresAt = new Date(Date.now() + 10 * 60_000);
  const provisioning = await beginStripeCustomerProvisioning({
    userId,
    operationKey: `beutl:customer-provisioning:${userId}:${replacesCustomerId ?? "initial"}`,
    stripeIdempotencyKey: customerIdempotencyKey,
    paramsJson: JSON.stringify(customerParams),
    leaseToken: provisioningLeaseToken,
    leaseExpiresAt: provisioningLeaseExpiresAt,
  });
  const customer = await createRecoverableCustomer({
    stripe,
    params: customerParams,
    idempotencyKey: customerIdempotencyKey,
    beforeCreate: async (key) => {
      const updated = await updateStripeCustomerProvisioningKey({ id: provisioning.id, stripeIdempotencyKey: key, leaseToken: provisioningLeaseToken });
      if (updated.count !== 1) {
        throw new Error("Stripe customer provisioning lease changed before remote create");
      }
    },
  });
  if (!hasStripeOwnerMetadata(customer.metadata, userId)) {
    throw new Error("Stripe did not persist customer ownership metadata");
  }
  let mappingCommitted = false;
  try {
    await recordStripeCustomerProvisioningRemote({
      id: provisioning.id,
      stripeCustomerId: customer.id,
      leaseToken: provisioningLeaseToken,
    });
    if (replacesCustomerId) {
      await expireOwnedOpenCheckoutSessions({
        stripe,
        customerId: replacesCustomerId,
        userId,
      });
      // Moving the mapping would hide billing on the old Customer from the
      // user's portal and all later deletion flows. Ownership cannot be proven
      // without metadata, so neither cancel the subscription nor migrate the
      // mapping; leave the account blocked for an operator to resolve.
      const left = await listActiveSubscriptionsOnCustomer(
        stripe,
        replacesCustomerId,
      );
      if (left.length > 0) {
        await addAuditLog({
          userId,
          action: auditLogActions.account.legacyCustomerLeftBilling,
          details:
            `Stripe customer ${replacesCustomerId} still billing `
            + `(${left.join(", ")}) — replacement blocked`,
        });
        throw new Error(
          `Cannot replace a legacy Stripe customer that still has `
          + `active subscriptions: ${replacesCustomerId}`,
        );
      }
      await replaceCustomerMappingWithVerifiedOwnership({
        userId,
        expectedStripeId: replacesCustomerId,
        stripeId: customer.id,
      });
    } else {
      await createVerifiedCustomerMappingIfAbsent({
        userId,
        stripeId: customer.id,
      });
    }
    const mapping = await findCustomerByUserId({ userId });
    if (!mapping || mapping.stripeId !== customer.id) {
      throw new Error("Stripe customer mapping changed concurrently");
    }
    mappingCommitted = true;

    // Persist the ownership mapping before secondary Stripe attributes. If this
    // update fails, the next billing operation retries it using the saved mapping.
    await syncCustomerEmail(stripe, customer.id, email);
    await settleStripeCustomerProvisioning({ id: provisioning.id, leaseToken: provisioningLeaseToken });
    return customer.id;
  } catch (error) {
    if (mappingCommitted) {
      throw error;
    }
    await scheduleStripeCustomerProvisioningCleanup({
      id: provisioning.id,
      leaseToken: provisioningLeaseToken,
      lastError: error instanceof Error ? error.message : String(error),
    }).catch((cleanupError) => {
      console.error("Could not persist Stripe customer cleanup", cleanupError);
    });
    await compensateUnmappedCustomer({ stripe, customer, userId });
    throw error;
  }
}

export async function createOrRetrieveOwnedCustomerId({
  email,
  userId,
}: {
  email: string;
  userId: string;
}): Promise<string> {
  if (await findAccountDeletionIntentByUserId({ userId })) {
    throw new Error("Account deletion is already authorized");
  }
  const mapping = await findCustomerByUserId({ userId });
  const stripe = createStripe();
  if (mapping) {
    const customer = await retrieveCustomerIfPresent(stripe, mapping.stripeId);
    if (customer) {
      const proof = await verifyCustomerOwnership({
        customer,
        ownership: mapping.ownership,
        userId,
      });
      if (proof !== "mismatch") {
        await syncCustomerEmail(stripe, customer.id, email);
        return customer.id;
      }
      throw new Error(
        `Cannot replace legacy Stripe customer ${mapping.stripeId} without verified ownership`,
      );
    }
    // A deleted Customer has no remote payable state left to strand, so its
    // local mapping may be replaced with a newly metadata-owned Customer.
    return await createOwnedCustomer({
      stripe,
      email,
      userId,
      replacesCustomerId: mapping.stripeId,
    });
  }

  return await createOwnedCustomer({ stripe, email, userId });
}

function isTerminalSubscription(subscription: Stripe.Subscription): boolean {
  return (
    subscription.status === "canceled" ||
    subscription.status === "incomplete_expired"
  );
}

type PersistedBillingOffer = NonNullable<
  Awaited<ReturnType<typeof findBillingOfferById>>
>;

function checkoutSessionMatchesBoundProCheckout({
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
  const lineItems = checkoutSession.line_items?.data;
  return (
    checkoutSession.id === stripeCheckoutSessionId &&
    checkoutSession.mode === "subscription" &&
    getExpandableId(checkoutSession.customer) === expectedCustomerId &&
    checkoutSession.metadata?.planId === PRO_PLAN.id &&
    checkoutSession.metadata?.billingOfferId === billingOffer.id &&
    hasStripeOwnerMetadata(checkoutSession.metadata, expectedUserId) &&
    billingOffer.kind === "pro" &&
    lineItems?.length === 1 &&
    lineItems[0].quantity === 1 &&
    getExpandableId(lineItems[0].price) === billingOffer.stripePriceId
  );
}

function subscriptionMatchesBoundProCheckout({
  subscription,
  billingOffer,
  expectedCustomerId,
  expectedUserId,
}: {
  subscription: Stripe.Subscription;
  billingOffer: PersistedBillingOffer;
  expectedCustomerId: string;
  expectedUserId: string;
}): boolean {
  if (
    billingOffer.kind !== "pro" ||
    subscription.items.data.length !== 1 ||
    getExpandableId(subscription.customer) !== expectedCustomerId ||
    subscription.metadata?.planId !== PRO_PLAN.id ||
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

async function resolveBoundProCheckoutForAccountDeletion({
  stripe,
  expectedCustomerId,
  userId,
}: {
  stripe: StripeClient;
  expectedCustomerId: string;
  userId: string;
}): Promise<void> {
  const attempt = await findBoundProCheckoutAttemptForAccountDeletion({
    userId,
  });
  if (!attempt) return;

  const [billingOffer, initialCheckoutSession] = await Promise.all([
    findBillingOfferById({ id: attempt.billingOfferId }),
    stripe.checkout.sessions.retrieve(attempt.stripeCheckoutSessionId, {
      expand: ["line_items.data.price"],
    }),
  ]);
  if (!billingOffer || billingOffer.kind !== "pro") {
    throw new Error(
      `Bound Checkout Session ${attempt.stripeCheckoutSessionId} has no Pro billing offer`,
    );
  }

  const retrieveCheckoutSession = async () =>
    await stripe.checkout.sessions.retrieve(attempt.stripeCheckoutSessionId, {
      expand: ["line_items.data.price"],
    });
  const matchesBinding = (checkoutSession: Stripe.Checkout.Session) =>
    checkoutSessionMatchesBoundProCheckout({
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
    !subscriptionMatchesBoundProCheckout({
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
        disposition: "superseded-pro-checkout",
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
  await resolveBoundProCheckoutForAccountDeletion({
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
      const isPro = Boolean(session.metadata?.billingOfferId) && !isTopUp;
      if (isTopUp) { if (!session.metadata?.topUpAttemptId || (await setTopUpCheckoutSession({ attemptId: session.metadata.topUpAttemptId, stripeCheckoutSessionId: session.id, expiresAt: session.expires_at ? new Date(session.expires_at * 1000) : new Date() })) === "not-stored") return { status: "owner-mismatch", customerId: customer.id }; }
      else if (isPackage || isPro) await scheduleStripeCheckoutCleanup({ sessionId: session.id, userId, kind: isPackage ? "package" : "pro", customerId: customer.id, packageId: isPackage ? session.metadata?.packageId : null, billingOfferId: isPro ? session.metadata?.billingOfferId : null });
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
      const isPro = Boolean(session.metadata?.billingOfferId) && !isTopUp;
      if (isPackage || isTopUp) {
        const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
        if (!paymentIntentId) return { status: "owner-mismatch", customerId: customer.id };
        let paymentIntent: Stripe.PaymentIntent;
        try { paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId); } catch { return { status: "owner-mismatch", customerId: customer.id }; }
        const chargeId = typeof paymentIntent.latest_charge === "string" ? paymentIntent.latest_charge : paymentIntent.latest_charge?.id;
        let charge: Stripe.Charge | null;
        try { charge = chargeId ? await stripe.charges.retrieve(chargeId) : null; } catch { return { status: "owner-mismatch", customerId: customer.id }; }
        if (!charge) return { status: "owner-mismatch", customerId: customer.id };
        if (charge.created < Math.floor(deletionAuthorizedAt.getTime() / 1000)) continue;
        if (isTopUp) {
          if (!session.metadata?.topUpAttemptId || (await setTopUpCheckoutSession({ attemptId: session.metadata.topUpAttemptId, stripeCheckoutSessionId: session.id, expiresAt: session.expires_at ? new Date(session.expires_at * 1000) : new Date() })) === "not-stored") return { status: "owner-mismatch", customerId: customer.id };
        } else await scheduleStripeCheckoutCleanup({ sessionId: session.id, userId, kind: "package", customerId: customer.id, packageId: session.metadata?.packageId, billingOfferId: null });
      } else if (isPro) {
        const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
        if (!subscriptionId) return { status: "owner-mismatch", customerId: customer.id };
        let subscription: Stripe.Subscription;
        try { subscription = await stripe.subscriptions.retrieve(subscriptionId); } catch { return { status: "owner-mismatch", customerId: customer.id }; }
        if (subscription.created < Math.floor(deletionAuthorizedAt.getTime() / 1000)) continue;
        await scheduleStripeCheckoutCleanup({ sessionId: session.id, userId, kind: "pro", customerId: customer.id, packageId: null, billingOfferId: session.metadata?.billingOfferId });
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
