import Stripe from "stripe";

export function createStripe() {
  return new Stripe(process.env.STRIPE_SECRET_KEY as string);
}
