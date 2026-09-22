import type { OfferPricingResult } from "@/lib/stripe-pricing";
import {
  AiOfferCardsPanel,
  type OfferAmount,
  type PriceSourceState,
} from "./economics-panel";
import { getAiEconomics } from "./queries";

// Stripe-backed offer prices are fetched on the server and handed to the
// client component, which recomputes the per-unit plan rate as fields change.

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
