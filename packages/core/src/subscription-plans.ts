// 契約できるプランの一覧。Subscription.planId / Stripe の metadata.planId /
// SubscriptionCheckoutAttempt.planId に入る値と、プランごとの静的な事実
// (BillingOffer.kind、ティアの集合、チェックアウトの識別子) をここで一元化する。
// Stripe の Price ID のような環境依存の値は持たない (apps/web 側の設定が持つ)。
//
// ティアは「同じプランの中の容量・割当の段階」。AI Pro はまだティアを持たないので
// 空の配列で、その契約の tier は null になる。増やすときはここに列挙するだけで、
// offer の検証・チェックアウト・観測の保存は同じ経路を通る。
import { STORAGE_TIER_IDS } from "./storage-plan";

export const SUBSCRIPTION_PLAN_IDS = ["pro", "storage"] as const;
export type SubscriptionPlanId = (typeof SUBSCRIPTION_PLAN_IDS)[number];

export type SubscriptionPlanDefinition = {
  id: SubscriptionPlanId;
  // BillingOffer.kind。プランと 1 対 1。
  offerKind: SubscriptionPlanId;
  tierIds: readonly string[];
  // Checkout Session を作るときの idempotency key の接頭辞。
  checkoutIdempotencyPrefix: string;
  // 置き換えられた完了済み Session を補償するときの BillingRefundAttempt.disposition。
  supersededDisposition: string;
  // 戻り URL の checkout= の値。
  checkoutSuccessParam: string;
};

export const SUBSCRIPTION_PLANS: Record<
  SubscriptionPlanId,
  SubscriptionPlanDefinition
> = {
  pro: {
    id: "pro",
    offerKind: "pro",
    tierIds: [],
    checkoutIdempotencyPrefix: "ai-pro-checkout",
    supersededDisposition: "superseded-pro-checkout",
    checkoutSuccessParam: "success",
  },
  storage: {
    id: "storage",
    offerKind: "storage",
    tierIds: STORAGE_TIER_IDS,
    checkoutIdempotencyPrefix: "storage-checkout",
    supersededDisposition: "superseded-storage-checkout",
    checkoutSuccessParam: "storage-success",
  },
};

export function isSubscriptionPlanId(value: unknown): value is SubscriptionPlanId {
  return (
    typeof value === "string" &&
    (SUBSCRIPTION_PLAN_IDS as readonly string[]).includes(value)
  );
}

export function subscriptionPlanOf(
  planId: unknown,
): SubscriptionPlanDefinition | null {
  return isSubscriptionPlanId(planId) ? SUBSCRIPTION_PLANS[planId] : null;
}

export function subscriptionPlanOfOfferKind(
  kind: string,
): SubscriptionPlanDefinition | null {
  for (const plan of Object.values(SUBSCRIPTION_PLANS)) {
    if (plan.offerKind === kind) return plan;
  }
  return null;
}

// プランがティアを持つなら、その一覧に含まれる文字列だけが有効。ティアの無い
// プランは null だけが有効。
export function isSubscriptionTier(
  plan: Pick<SubscriptionPlanDefinition, "tierIds">,
  tier: unknown,
): boolean {
  if (plan.tierIds.length === 0) return tier === null || tier === undefined;
  return typeof tier === "string" && plan.tierIds.includes(tier);
}

export type SubscriptionState = {
  status: string;
  planId: string;
  tier: string | null;
  billingOfferId: string | null;
  currentPeriodEnd: Date | null;
  cancelAt: Date | null;
  entitlementHeld?: boolean;
};

// 期間末より前に cancel_at が指定されていればそちらが実効の終了。
export function effectiveSubscriptionEnd(
  subscription: Pick<SubscriptionState, "currentPeriodEnd" | "cancelAt">,
): Date | null {
  if (subscription.currentPeriodEnd === null) return null;
  if (
    subscription.cancelAt != null &&
    subscription.cancelAt.getTime() < subscription.currentPeriodEnd.getTime()
  ) {
    return subscription.cancelAt;
  }
  return subscription.currentPeriodEnd;
}

// 契約が今この瞬間に権利を与えているか。どのプランでも同じ規則:
// active で、返金・異議の hold が無く、Price が既知 (offer あり) で、実効の終了が未来。
export function isActiveSubscription(
  subscription: SubscriptionState | null,
  planId: SubscriptionPlanId,
  now: Date = new Date(),
): boolean {
  if (!subscription) return false;
  const effectiveEnd = effectiveSubscriptionEnd(subscription);
  return (
    subscription.status === "active" &&
    subscription.entitlementHeld !== true &&
    subscription.planId === planId &&
    typeof subscription.billingOfferId === "string" &&
    subscription.billingOfferId.length > 0 &&
    effectiveEnd !== null &&
    effectiveEnd.getTime() > now.getTime()
  );
}

// 有効な契約のティア。この版のコードが知らないティア文字列は null (そのプランの
// 「ティア無し」相当) に落とす。アップロードの取引の中で呼ばれるので throw しない。
export function activeSubscriptionTierOf(
  subscription: SubscriptionState | null,
  planId: SubscriptionPlanId,
  now: Date = new Date(),
): string | null {
  if (!isActiveSubscription(subscription, planId, now)) return null;
  const tier = subscription!.tier;
  return SUBSCRIPTION_PLANS[planId].tierIds.includes(tier ?? "") ? tier : null;
}
