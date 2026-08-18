import type { OfferPricingResult } from "@/lib/stripe-pricing";
import {
  AiOfferCardsPanel,
  AiOperationEconomicsPanel,
  type OfferAmount,
  type PriceSourceState,
} from "./economics-panel";
import { aiCostEstimateKey } from "@beutl/api";
import {
  getAiEconomics,
  getAiModelCatalog,
  getAiOperationModels,
} from "./queries";

// The server side of the economics panels: it only fetches what needs the
// network — Stripe prices and the provider cost estimates — and hands it to the
// client components, which recompute the derived figures as fields are edited.

function toOfferAmount(result: OfferPricingResult): OfferAmount {
  if (!result.effective) return null;
  return {
    unitAmount: result.effective.unitAmount,
    currency: result.effective.currency,
    creditAmount: result.effective.creditAmount,
  };
}

function toSourceState(result: OfferPricingResult): PriceSourceState {
  return {
    source: result.source,
    stripeError: result.stripeError,
    mismatch: result.mismatch,
    stripePriceId: result.effective?.stripePriceId ?? null,
  };
}

// One panel per model the operation can run on. An operation with no registered
// rows still gets one, for the single model the settings page holds.
export async function AiOperationEconomics({
  lang,
  operation,
}: {
  lang: string;
  operation: string;
}) {
  const [{ pro, topUpUnitValue, costByModel }, catalog] = await Promise.all([
    getAiEconomics(),
    getAiModelCatalog(),
  ]);
  const entries = catalog.list(operation);
  const registered = new Set(
    (await getAiOperationModels())
      .filter((row) => row.operation === operation)
      .map((row) => row.modelId),
  );

  return (
    <div className="flex flex-col gap-3">
      {entries.map((entry) => (
        <AiOperationEconomicsPanel
          key={entry.modelId}
          lang={lang}
          operation={operation}
          model={entry.modelId}
          priceUnits={registered.has(entry.modelId) ? entry.priceUnits : null}
          estimate={costByModel.get(
            aiCostEstimateKey(operation, entry.modelId),
          )}
          proOffer={toOfferAmount(pro)}
          topUpUnitValue={topUpUnitValue}
        />
      ))}
    </div>
  );
}

// Rendered until the prices arrive. The allowance figure needs no network, so
// the panel still computes and updates it while the rest is pending.
export function AiOperationEconomicsFallback({
  lang,
  operation,
  model,
  priceUnits,
}: {
  lang: string;
  operation: string;
  model: string;
  priceUnits: number | null;
}) {
  return (
    <AiOperationEconomicsPanel
      lang={lang}
      operation={operation}
      model={model}
      priceUnits={priceUnits}
      estimate={undefined}
      proOffer={null}
      topUpUnitValue={null}
    />
  );
}

export async function AiOfferCards({ lang }: { lang: string }) {
  const { pro, topUp, topUpUnitValue } = await getAiEconomics();
  return (
    <AiOfferCardsPanel
      lang={lang}
      proOffer={toOfferAmount(pro)}
      proState={toSourceState(pro)}
      topUpOffer={toOfferAmount(topUp)}
      topUpState={toSourceState(topUp)}
      topUpUnitValue={topUpUnitValue}
    />
  );
}

export function AiOfferCardsFallback({ label }: { label: string }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {[0, 1].map((index) => (
        <div
          key={index}
          className="rounded-lg border bg-card p-4 text-sm text-muted-foreground"
        >
          {label}
        </div>
      ))}
    </div>
  );
}
