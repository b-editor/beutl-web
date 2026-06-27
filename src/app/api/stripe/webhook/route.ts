import { addAuditLog, auditLogActions } from "@/lib/audit-log";
import { findCustomerByStripeId } from "@/lib/db/customer";
import { findPackageIdById } from "@/lib/db/package";
import {
  createUserPaymentHistory,
  existsUserPaymentHistoryByPaymentId,
} from "@/lib/db/user-payment-history";
import { createUserPackage } from "@/lib/db/user-package";
import { createStripe } from "@/lib/stripe/config";
import { type NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const stripe = createStripe();
  const sig = request.headers.get("stripe-signature");
  if (!sig) {
    return NextResponse.json({ message: "No signature" }, { status: 400 });
  }

  // 署名を確認する
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
      case "payment_intent.succeeded": {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        if (typeof paymentIntent.customer !== "string") {
          return NextResponse.json(
            { message: "paymentIntent.customer is not string" },
            { status: 400 },
          );
        }

        // 冪等化: 同じ payment_intent が再送されても二重付与しない
        if (
          await existsUserPaymentHistoryByPaymentId({
            paymentId: paymentIntent.id,
          })
        ) {
          return NextResponse.json({ received: true });
        }

        const customer = await findCustomerByStripeId({
          stripeId: paymentIntent.customer,
        });
        if (!customer) {
          return NextResponse.json(
            { message: "User not found" },
            { status: 404 },
          );
        }
        const pkg = await findPackageIdById({
          id: paymentIntent.metadata.packageId,
        });
        if (!pkg) {
          return NextResponse.json(
            { message: "Package not found" },
            { status: 404 },
          );
        }
        await createUserPackage({
          userId: customer.userId,
          packageId: pkg.id,
        });
        await createUserPaymentHistory({
          userId: customer.userId,
          packageId: pkg.id,
          paymentIntentId: paymentIntent.id,
        });
        await addAuditLog({
          userId: customer.userId,
          action: auditLogActions.store.paymentSucceeded,
          details: `packageId: ${pkg.id}`,
        });
        break;
      }
    }
  } catch (err) {
    console.error("Stripe webhook handler failed", err);
    return NextResponse.json({ message: "Internal error" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
