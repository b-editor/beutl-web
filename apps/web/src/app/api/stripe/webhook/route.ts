import { createStripe } from "@/lib/stripe/config";
import { handleStripeEvent } from "@/lib/stripe/webhook";
import { type NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const stripe = createStripe();
  const sig = request.headers.get("stripe-signature");
  if (!sig) {
    return NextResponse.json({ message: "No signature" }, { status: 400 });
  }

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
    const result = await handleStripeEvent(stripe, event);
    if (result?.error) {
      return NextResponse.json({ message: result.error }, { status: 400 });
    }
  } catch (err) {
    console.error("Stripe webhook handler failed", err);
    return NextResponse.json({ message: "Internal error" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
