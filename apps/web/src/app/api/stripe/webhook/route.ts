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
}: {
  paymentIntent: Stripe.PaymentIntent;
  stripe: StripeClient;
  requireValidPayment: boolean;
}): Promise<PackagePaymentReference | null> {
  const existing = await findPackagePaymentReference({
    paymentId: paymentIntent.id,
  });
  if (existing) {
    return existing;
  }

  if (requireValidPayment) {
    const payment = await resolvePackagePayment({ paymentIntent, stripe });
    return payment.status === "fulfill" ? payment.reference : null;
  }
  const owner = await resolvePackagePaymentOwner({ paymentIntent, stripe });
  return owner.status === "owned" ? owner.reference : null;
}

async function handlePaymentSucceeded(
  stripe: StripeClient,
  paymentIntent: Stripe.PaymentIntent,
  event: Stripe.Event,
): Promise<void> {
  if (await findPackagePaymentReference({ paymentId: paymentIntent.id })) {
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
  const paymentIntentId = getExpandableId(charge.payment_intent);
  if (!paymentIntentId) {
    return;
  }
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  const reference = await resolveReversalReference({
    paymentIntent,
    stripe,
    requireValidPayment: false,
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
    reason: `charge refunded: ${charge.id}`,
  });
  await addPaymentAuditLog(
    result,
    auditLogActions.store.paymentRevoked,
    `state: revoked, chargeId: ${charge.id}`,
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
  const reference = await resolveReversalReference({
    paymentIntent,
    stripe,
    requireValidPayment: !shouldRevoke,
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

  const chargeId = getExpandableId(dispute.charge);
  if (chargeId) {
    const charge = await stripe.charges.retrieve(chargeId);
    if (charge.amount_refunded > 0) {
      return;
    }
  }
  const result = await restorePackagePayment({
    paymentId: paymentIntent.id,
    reference: reference
      ? { userId: reference.userId, packageId: reference.packageId }
      : undefined,
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
