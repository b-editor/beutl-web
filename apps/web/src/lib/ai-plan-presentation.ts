type AiPlanEntitlementPresentationInput = {
  canUseAi: boolean;
  subscriptionStatus: string | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
};

export type AiPlanStatusPresentation =
  | "active"
  | "cancelScheduled"
  | "canceled"
  | "needsAttention"
  | "none";

export type AiPlanPresentation = {
  status: AiPlanStatusPresentation;
  canManageSubscription: boolean;
  showCurrentPeriodEnd: boolean;
  showCancellationNotice: boolean;
};

// Stripe can report a scheduled cancellation locally before it sends the
// terminal subscription webhook. Once the effective end has passed, the UI
// must offer a new subscription rather than trapping the user in the portal.
export function getAiPlanPresentation(
  entitlements: AiPlanEntitlementPresentationInput,
  now = new Date(),
): AiPlanPresentation {
  const periodEnd = entitlements.currentPeriodEnd
    ? new Date(entitlements.currentPeriodEnd)
    : null;
  const cancellationHasElapsed =
    entitlements.cancelAtPeriodEnd &&
    periodEnd !== null &&
    !Number.isNaN(periodEnd.getTime()) &&
    periodEnd.getTime() <= now.getTime();
  const cancellationIsScheduled =
    entitlements.canUseAi &&
    entitlements.cancelAtPeriodEnd &&
    !cancellationHasElapsed;
  const canManageSubscription =
    entitlements.subscriptionStatus !== null &&
    entitlements.subscriptionStatus !== "canceled" &&
    entitlements.subscriptionStatus !== "incomplete_expired" &&
    !cancellationHasElapsed;

  let status: AiPlanStatusPresentation;
  if (cancellationIsScheduled) {
    status = "cancelScheduled";
  } else if (entitlements.canUseAi) {
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
