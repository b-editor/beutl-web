// AI Pro の見え方。判定そのものは商品に依らないので subscription-presentation.ts
// にあり、ここは canUseAi を「権利あり」に読み替えるだけ。
import {
  getSubscriptionPresentation,
  type SubscriptionPresentation,
  type SubscriptionStatusPresentation,
} from "./subscription-presentation";

type AiPlanEntitlementPresentationInput = {
  canUseAi: boolean;
  subscriptionStatus: string | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
};

export type AiPlanStatusPresentation = SubscriptionStatusPresentation;
export type AiPlanPresentation = SubscriptionPresentation;

export function getAiPlanPresentation(
  entitlements: AiPlanEntitlementPresentationInput,
  now = new Date(),
): AiPlanPresentation {
  return getSubscriptionPresentation(
    { ...entitlements, entitled: entitlements.canUseAi },
    now,
  );
}
