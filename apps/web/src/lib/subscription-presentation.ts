type SubscriptionPresentationInput = {
  // 今この契約が権利を与えているか (AI なら canUseAi、ストレージなら有料枠が有効か)。
  entitled: boolean;
  subscriptionStatus: string | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
};

export type SubscriptionStatusPresentation =
  | "active"
  | "cancelScheduled"
  | "canceled"
  | "needsAttention"
  | "none";

export type SubscriptionPresentation = {
  status: SubscriptionStatusPresentation;
  canManageSubscription: boolean;
  showCurrentPeriodEnd: boolean;
  showCancellationNotice: boolean;
};

// Stripe can report a scheduled cancellation locally before it sends the
// terminal subscription webhook. Once the effective end has passed, the UI
// must offer a new subscription rather than trapping the user in the portal.
export function getSubscriptionPresentation(
  entitlements: SubscriptionPresentationInput,
  now = new Date(),
): SubscriptionPresentation {
  const periodEnd = entitlements.currentPeriodEnd
    ? new Date(entitlements.currentPeriodEnd)
    : null;
  const cancellationHasElapsed =
    entitlements.cancelAtPeriodEnd &&
    periodEnd !== null &&
    !Number.isNaN(periodEnd.getTime()) &&
    periodEnd.getTime() <= now.getTime();
  const cancellationIsScheduled =
    entitlements.entitled &&
    entitlements.cancelAtPeriodEnd &&
    !cancellationHasElapsed;
  const canManageSubscription =
    entitlements.subscriptionStatus !== null &&
    entitlements.subscriptionStatus !== "canceled" &&
    entitlements.subscriptionStatus !== "incomplete_expired" &&
    !cancellationHasElapsed;

  let status: SubscriptionStatusPresentation;
  if (cancellationIsScheduled) {
    status = "cancelScheduled";
  } else if (entitlements.entitled) {
    status = "active";
  } else if (
    cancellationHasElapsed ||
    entitlements.subscriptionStatus === "canceled"
  ) {
    status = "canceled";
  } else if (canManageSubscription) {
    status = "needsAttention";
  } else {
    status = "none";
  }

  return {
    status,
    canManageSubscription,
    showCurrentPeriodEnd:
      entitlements.currentPeriodEnd !== null && !cancellationHasElapsed,
    showCancellationNotice: cancellationIsScheduled,
  };
}
