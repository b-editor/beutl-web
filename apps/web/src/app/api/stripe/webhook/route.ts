import { addAuditLog, auditLogActions } from "@/lib/audit-log";
import { createStripe } from "@/lib/stripe/config";
import {
  refundPackagePayment,
  resolvePackagePayment,
  resolvePackagePaymentOwner,
} from "@/lib/stripe/package-payment";
import { getExpandableId } from "@/lib/stripe/ownership";
import {
  findPackagePaymentReference,
  PACKAGE_PAYMENT_EVENT_RANK,
  recordPackagePaymentSucceeded,
  restorePackagePayment,
  revokePackagePayment,
  type PackagePaymentReference,
  type PackagePaymentStateResult,
} from "@beutl/db";
import { type NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";

type StripeClient = ReturnType<typeof createStripe>;

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
  await revokeRefundedPayment({
    stripe,
    event,
    paymentIntentId,
    chargeId: charge.id,
    refundId: refund.id,
  });
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
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ message: "No signature" }, { status: 400 });
  }

  const body = await request.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_ENDPOINT_SECRET as string,
    );
  } catch (error) {
    console.error("Stripe webhook signature verification failed", error);
    return NextResponse.json({ message: "Invalid signature" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "payment_intent.succeeded":
        await handlePaymentSucceeded(
          stripe,
          event.data.object as Stripe.PaymentIntent,
          event,
        );
        break;
      case "charge.refunded":
        await handleRefundedCharge(
          stripe,
          event.data.object as Stripe.Charge,
          event,
        );
        break;
      case "refund.created":
      case "refund.updated":
      case "refund.failed":
        await handleRefund(
          stripe,
          event.data.object as Stripe.Refund,
          event,
        );
        break;
      case "charge.dispute.created":
      case "charge.dispute.updated":
      case "charge.dispute.closed":
      case "charge.dispute.funds_withdrawn":
      case "charge.dispute.funds_reinstated":
        await handleDispute(
          stripe,
          event.data.object as Stripe.Dispute,
          event,
        );
        break;
    }
  } catch (error) {
    console.error("Stripe webhook handler failed", error);
    return NextResponse.json({ message: "Internal error" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
