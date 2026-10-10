import Stripe from "stripe";

// Keep the wire contract used by existing billing records and webhooks while
// upgrading the SDK. Changing the Stripe API version is a separate migration.
export const STRIPE_API_VERSION = "2026-02-25.clover";

export function createStripeClient(secretKey: string, options: Omit<Stripe.StripeConfig, "apiVersion"> = {}): Stripe {
  return new Stripe(secretKey, {
    ...options,
    // @ts-expect-error Stripe types describe only the SDK's latest API version.
    apiVersion: STRIPE_API_VERSION,
  });
}
