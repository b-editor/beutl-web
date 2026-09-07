// プランごとの Stripe 側の設定。権利を与えられる Price は env に明示されたもの
// だけで、顧客が編集した契約から Price を「学習」することはない。静的な事実
// (offer の kind、ティアの集合、識別子) は @beutl/core の定義が持ち、ここは
// 環境変数に依存する Price の対応だけを足す。
import {
  SUBSCRIPTION_PLANS,
  subscriptionPlanOf,
  type SubscriptionPlanDefinition,
  type SubscriptionPlanId,
} from "@beutl/core";

export type HistoricalOffer = { productId: string; tier: string | null };

export type SubscriptionPlanConfig = SubscriptionPlanDefinition & {
  // 現行の販売用 Price。ティアの無いプランは null で引く。
  currentPriceId(tier: string | null): string | undefined;
  priceEnvName(tier: string | null): string;
  // 販売を止めた Price。既存の契約者の更新と返金には使い続ける。
  historicalOffers(): ReadonlyMap<string, HistoricalOffer>;
};

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

// "priceId:productId[:tier],..." を読む。ティアを持つプランは tier が必須、
// 持たないプランは tier を書けない。
function parseHistoricalOffers(
  plan: SubscriptionPlanDefinition,
  envName: string,
): ReadonlyMap<string, HistoricalOffer> {
  const result = new Map<string, HistoricalOffer>();
  const configured = process.env[envName]?.trim();
  if (!configured) return result;
  const hasTiers = plan.tierIds.length > 0;
  for (const entry of configured.split(",")) {
    const parts = entry.split(":").map((part) => part.trim());
    const [priceId, productId, tier] = parts;
    const shape = hasTiers ? 3 : 2;
    if (
      parts.length !== shape ||
      !priceId ||
      !productId ||
      (hasTiers && !plan.tierIds.includes(tier ?? "")) ||
      result.has(priceId)
    ) {
      throw new Error(
        hasTiers
          ? `${envName} must contain unique priceId:productId:tier triples`
          : `${envName} must contain unique priceId:productId pairs`,
      );
    }
    result.set(priceId, { productId, tier: hasTiers ? tier! : null });
  }
  return result;
}

const STORAGE_PRICE_ENV: Record<string, string> = {
  "100gb": "STRIPE_STORAGE_PRICE_ID_100GB",
  "200gb": "STRIPE_STORAGE_PRICE_ID_200GB",
  "1tb": "STRIPE_STORAGE_PRICE_ID_1TB",
};

const CONFIGS: Record<SubscriptionPlanId, SubscriptionPlanConfig> = {
  pro: {
    ...SUBSCRIPTION_PLANS.pro,
    priceEnvName: () => "STRIPE_PRO_PRICE_ID",
    currentPriceId: () => readEnv("STRIPE_PRO_PRICE_ID"),
    historicalOffers: () =>
      parseHistoricalOffers(SUBSCRIPTION_PLANS.pro, "STRIPE_PRO_HISTORICAL_OFFERS"),
  },
  storage: {
    ...SUBSCRIPTION_PLANS.storage,
    priceEnvName: (tier) => STORAGE_PRICE_ENV[tier ?? ""] ?? "STRIPE_STORAGE_PRICE_ID",
    currentPriceId: (tier) => {
      const envName = STORAGE_PRICE_ENV[tier ?? ""];
      return envName ? readEnv(envName) : undefined;
    },
    historicalOffers: () =>
      parseHistoricalOffers(
        SUBSCRIPTION_PLANS.storage,
        "STRIPE_STORAGE_HISTORICAL_OFFERS",
      ),
  },
};

export function subscriptionPlanConfig(
  planId: SubscriptionPlanId,
): SubscriptionPlanConfig {
  return CONFIGS[planId];
}

// Stripe の契約がどのプランのものか。metadata.planId が既知でなければ null。
export function subscriptionPlanConfigOf(
  planId: unknown,
): SubscriptionPlanConfig | null {
  const plan = subscriptionPlanOf(planId);
  return plan ? CONFIGS[plan.id] : null;
}

// 権利を与えられる Price の集合: 全ティアの現行 Price + 履歴。
export function configuredPriceIds(plan: SubscriptionPlanConfig): ReadonlySet<string> {
  const result = new Set(plan.historicalOffers().keys());
  const tiers: Array<string | null> = plan.tierIds.length > 0 ? [...plan.tierIds] : [null];
  for (const tier of tiers) {
    const priceId = plan.currentPriceId(tier);
    if (priceId) result.add(priceId);
  }
  return result;
}

export type ConfiguredPrice = {
  tier: string | null;
  // 現行の販売用 Price か (履歴なら false)。
  isCurrent: boolean;
  // 履歴の Price に期待する Product。現行なら null。
  historicalProductId: string | null;
};

// この Price をこのプランのどのティアとして扱うか。現行を先に、次に履歴を見る。
export function configuredPriceOf(
  plan: SubscriptionPlanConfig,
  priceId: string,
): ConfiguredPrice | null {
  const tiers: Array<string | null> = plan.tierIds.length > 0 ? [...plan.tierIds] : [null];
  for (const tier of tiers) {
    if (plan.currentPriceId(tier) === priceId) {
      return { tier, isCurrent: true, historicalProductId: null };
    }
  }
  const historical = plan.historicalOffers().get(priceId);
  if (historical) {
    return {
      tier: historical.tier,
      isCurrent: false,
      historicalProductId: historical.productId,
    };
  }
  return null;
}
