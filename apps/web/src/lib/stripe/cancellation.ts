// Determines whether a subscription is scheduled to stop at the end of its
// period.
//
// `cancel_at_period_end` alone is not enough. On current Stripe API versions a
// customer portal cancellation records the scheduled end in `cancel_at` and
// leaves `cancel_at_period_end` false, so reading only the boolean reports the
// plan as unchanged and the user cannot tell that their cancellation
// registered. Treat either signal as a scheduled cancellation.
import type Stripe from "stripe";

export function isCancellationScheduled(
  subscription: Pick<
    Stripe.Subscription,
    "cancel_at_period_end" | "cancel_at" | "canceled_at"
  >,
): boolean {
  if (subscription.cancel_at_period_end === true) {
    return true;
  }
  // `canceled_at` is also set for a cancellation that already took effect; in
  // that case the status is terminal and this flag no longer matters.
  return typeof subscription.cancel_at === "number" && subscription.cancel_at > 0;
}

// The moment access ends for a scheduled cancellation. Stripe reports it in
// `cancel_at`, which normally equals the current period end but can differ when
// the cancellation was scheduled for a specific date.
export function getScheduledCancellationTime(
  subscription: Pick<Stripe.Subscription, "cancel_at">,
): Date | null {
  return typeof subscription.cancel_at === "number" && subscription.cancel_at > 0
    ? new Date(subscription.cancel_at * 1000)
    : null;
}
