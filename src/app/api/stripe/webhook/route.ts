import { addAuditLog, auditLogActions } from "@/lib/audit-log";
import { findCustomerByStripeId } from "@/lib/db/customer";
import { findPackageIdById } from "@/lib/db/package";
import { createUserPaymentHistory } from "@/lib/db/user-payment-history";
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
  const event = stripe.webhooks.constructEvent(
    body,
    sig,
    process.env.STRIPE_ENDPOINT_SECRET as string,
  );

  switch (event.type) {
    case "payment_intent.succeeded": {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      if (typeof paymentIntent.customer !== "string") {
        return NextResponse.json(
          { message: "paymentIntent.customer is not string" },
          { status: 400 },
        );
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
  return NextResponse.json({ received: true });
}
