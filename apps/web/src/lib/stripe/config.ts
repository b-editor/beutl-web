import Stripe from "stripe";
import { createStripeClient } from "@beutl/api/stripe-client";

export function createStripe() {
  return createStripeClient(process.env.STRIPE_SECRET_KEY as string, {
    httpClient: Stripe.createFetchHttpClient()
  });
}
