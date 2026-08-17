import "server-only";
import { cache } from "react";
import { getDb } from "@beutl/db";
import { loadAiCostEstimates, loadAiSettings } from "@beutl/api";
import { derivePlanUnitValue, deriveTopUpUnitValue } from "@beutl/core";
import { resolveOfferPricing } from "@/lib/stripe-pricing";

export const getAiSettings = cache(async () => await loadAiSettings());

// Prices and provider costs both go over the network, so every place that shows
// them sits behind its own Suspense boundary. They all await this one call:
// React's cache keeps it to a single fetch per request no matter how many
// operation sections ask for it.
export const getAiEconomics = cache(async () => {
  const settings = await getAiSettings();
  const monthlyUsageLimit = settings.getMonthlyUsageLimit();

  // getDb() は Hyperdrive の maxUses:1 に合わせて呼ぶたび新しい接続を張るため、
  // 両方のオファー取得で 1 つのクライアントを共有する。
  const prisma = await getDb();
  const [pro, topUp, costs] = await Promise.all([
    resolveOfferPricing({ kind: "pro", prisma }),
    resolveOfferPricing({ kind: "top_up", prisma }),
    loadAiCostEstimates({ modelOf: (operation) => settings.getModel(operation) }),
  ]);

  return {
    pro,
    topUp,
    costByOperation: new Map(
      costs.entries.map((entry) => [entry.operation, entry.estimate]),
    ),
    // What the plan earns per unit from a subscriber who spends the whole
    // allowance. Operation prices are valued at this rate because it is the
    // floor of Pro revenue, which is what a provider cost has to fit under.
    planUnitValue: derivePlanUnitValue(pro.effective, monthlyUsageLimit),
    topUpUnitValue: deriveTopUpUnitValue(topUp.effective),
  };
});
