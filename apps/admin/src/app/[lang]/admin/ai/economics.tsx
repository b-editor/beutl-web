import type { OfferPricingResult } from "@/lib/stripe-pricing";
import {
  AiOfferCardsPanel,
  AiOperationEconomicsPanel,
  type OfferAmount,
  type PriceSourceState,
} from "./economics-panel";
import { getAiEconomics } from "./queries";

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

export async function AiOperationEconomics({
  lang,
  operation,
}: {
  lang: string;
  operation: string;
}) {
  const { pro, topUpUnitValue, costByOperation } = await getAiEconomics();
  return (
    <AiOperationEconomicsPanel
      lang={lang}
      operation={operation}
      estimate={costByOperation.get(operation)}
      proOffer={toOfferAmount(pro)}
      topUpUnitValue={topUpUnitValue}
    />
  );
}

// Rendered until the prices arrive. The allowance figure needs no network, so
// the panel still computes and updates it while the rest is pending.
export function AiOperationEconomicsFallback({
  lang,
  operation,
}: {
  lang: string;
  operation: string;
}) {
  return (
    <AiOperationEconomicsPanel
      lang={lang}
      operation={operation}
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
