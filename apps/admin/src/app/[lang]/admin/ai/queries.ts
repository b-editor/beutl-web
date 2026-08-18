import "server-only";
import { cache } from "react";
import { getDb, listAiOperationModels } from "@beutl/db";
import {
  aiCostEstimateKey,
  isVideoModelUsable,
  loadAiCostEstimates,
  loadAiModelCatalog,
  loadAiSettings,
  loadAiVideoModelCapabilities,
} from "@beutl/api";
import { derivePlanUnitValue, deriveTopUpUnitValue } from "@beutl/core";
import { resolveOfferPricing } from "@/lib/stripe-pricing";

export const getAiSettings = cache(async () => await loadAiSettings());

// The rows an administrator registered, exactly as stored. The page edits these
// rather than the resolved catalog, so an operation with none shows an empty
// list rather than the built-in fallback pretending to be a row.
export const getAiOperationModels = cache(
  async () => await listAiOperationModels(),
);

// The video models that cannot serve a single request this service can build.
//
// Which resolutions, lengths and aspect ratios a video model takes differs per
// model, and one that shares none with this service is registered but dead: the
// provider refuses everything it is sent. Nothing else on this page would show
// that, and on the user's screen it reads as a provider outage.
export const getUnusableVideoModels = cache(async () => {
  const capabilities = await loadAiVideoModelCapabilities();
  return new Set(
    [...capabilities.values()]
      .filter((entry) => !isVideoModelUsable(entry))
      .map((entry) => entry.modelId),
  );
});

// What each operation can actually run on, fallback included. The economics
// panels price these, since a fallback costs the operator just as much as a
// registered row does.
export const getAiModelCatalog = cache(async () => await loadAiModelCatalog());

// Prices and provider costs both go over the network, so every place that shows
// them sits behind its own Suspense boundary. They all await this one call:
// React's cache keeps it to a single fetch per request no matter how many
// operation sections ask for it.
export const getAiEconomics = cache(async () => {
  const [settings, catalog] = await Promise.all([
    getAiSettings(),
    getAiModelCatalog(),
  ]);
  const monthlyUsageLimit = settings.getMonthlyUsageLimit();

  // getDb() は Hyperdrive の maxUses:1 に合わせて呼ぶたび新しい接続を張るため、
  // 両方のオファー取得で 1 つのクライアントを共有する。
  const prisma = await getDb();
  const [pro, topUp, costs] = await Promise.all([
    resolveOfferPricing({ kind: "pro", prisma }),
    resolveOfferPricing({ kind: "top_up", prisma }),
    loadAiCostEstimates({
      modelsOf: (operation) =>
        catalog.list(operation).map((entry) => entry.modelId),
    }),
  ]);

  return {
    pro,
    topUp,
    // Keyed by operation and model together: one operation now has several, and
    // two operations sharing a model still cost different amounts per run.
    costByModel: new Map(
      costs.entries.map((entry) => [
        aiCostEstimateKey(entry.operation, entry.model),
        entry.estimate,
      ]),
    ),
    // What the plan earns per unit from a subscriber who spends the whole
    // allowance. Operation prices are valued at this rate because it is the
    // floor of Pro revenue, which is what a provider cost has to fit under.
    planUnitValue: derivePlanUnitValue(pro.effective, monthlyUsageLimit),
    topUpUnitValue: deriveTopUpUnitValue(topUp.effective),
  };
});
