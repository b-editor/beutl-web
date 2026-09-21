"use client";

import {
  AI_PLAN_MONTHLY_USAGE_LIMIT_KEY,
  derivePlanUnitValue,
  formatAmount,
  formatFractionalAmount,
  type AiUnitValue,
} from "@beutl/core";
import { useTranslation } from "@beutl/ui/i18n-client";
import { Badge } from "@beutl/ui/ui/badge";
import { formatNumber } from "@/lib/format";
import { useAiSettingField } from "./settings-form";

// The cards run on the client so the plan's per-unit rate follows the monthly
// allowance field while it is being edited. Stripe prices come from the server.

export type OfferAmount = {
  unitAmount: number;
  currency: string;
  creditAmount: number | null;
} | null;

export type PriceSourceState = {
  source: "stripe" | "database" | null;
  stripeError: string | null;
  mismatch: boolean;
  stripePriceId: string | null;
};

// A draft is a string mid-edit and can be empty or half-typed. Anything that is
// not a usable number yields no figure at all rather than a misleading zero.
function usableNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

type Translator = ReturnType<typeof useTranslation>["t"];

function PriceSourceBadge({
  state,
  t,
}: {
  state: PriceSourceState;
  t: Translator;
}) {
  if (state.source === "stripe") {
    return (
      <Badge variant="default">{t("admin:ai.economics.source.stripe")}</Badge>
    );
  }
  if (state.source === "database") {
    return (
      <Badge variant="outline">{t("admin:ai.economics.source.database")}</Badge>
    );
  }
  return (
    <Badge variant="outline">{t("admin:ai.economics.source.missing")}</Badge>
  );
}

function OfferCard({
  lang,
  t,
  state,
  offer,
  unitValue,
  titleKey,
  rateKey,
  detail,
}: {
  lang: string;
  t: Translator;
  state: PriceSourceState;
  offer: OfferAmount;
  unitValue: AiUnitValue | null;
  titleKey: string;
  rateKey: string;
  detail: string | null;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{t(titleKey)}</span>
        <PriceSourceBadge state={state} t={t} />
      </div>
      {offer ? (
        <>
          <div className="text-2xl font-bold tabular-nums">
            {formatAmount(offer.unitAmount, offer.currency, lang)}
          </div>
          {unitValue && (
            <div className="text-sm">
              {t(rateKey, {
                rate: formatFractionalAmount(
                  unitValue.minorUnitsPerUnit,
                  unitValue.currency,
                  lang,
                ),
              })}
            </div>
          )}
          {detail && (
            <div className="text-xs text-muted-foreground">{detail}</div>
          )}
          {state.stripePriceId && (
            <code className="truncate text-xs text-muted-foreground">
              {state.stripePriceId}
            </code>
          )}
          {state.mismatch && (
            <p className="text-xs text-destructive">
              {t("admin:ai.economics.source.mismatch")}
            </p>
          )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t(
            `admin:ai.economics.source.error.${state.stripeError ?? "unavailable"}`,
          )}
        </p>
      )}
    </div>
  );
}

export function AiOfferCardsPanel({
  lang,
  proOffer,
  proState,
  topUpOffer,
  topUpState,
  topUpUnitValue,
}: {
  lang: string;
  proOffer: OfferAmount;
  proState: PriceSourceState;
  topUpOffer: OfferAmount;
  topUpState: PriceSourceState;
  topUpUnitValue: AiUnitValue | null;
}) {
  const { t } = useTranslation(lang);
  const limitField = useAiSettingField(AI_PLAN_MONTHLY_USAGE_LIMIT_KEY);
  const allowance = usableNumber(limitField.value);

  // Only the plan rate moves with the allowance; a top-up grants a fixed number
  // of units regardless.
  const planUnitValue =
    allowance !== null ? derivePlanUnitValue(proOffer, allowance) : null;

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <OfferCard
        lang={lang}
        t={t}
        state={proState}
        offer={proOffer}
        unitValue={planUnitValue}
        titleKey="admin:ai.economics.proOffer"
        rateKey="admin:ai.economics.planRateValue"
        detail={
          allowance === null
            ? null
            : t("admin:ai.economics.planRateDetail", {
                limit: formatNumber(allowance, lang),
              })
        }
      />
      <OfferCard
        lang={lang}
        t={t}
        state={topUpState}
        offer={topUpOffer}
        unitValue={topUpUnitValue}
        titleKey="admin:ai.economics.topUpOffer"
        rateKey="admin:ai.economics.topUpRateValue"
        detail={
          topUpOffer?.creditAmount
            ? t("admin:ai.economics.topUpRateDetail", {
                credits: formatNumber(topUpOffer.creditAmount, lang),
              })
            : null
        }
      />
    </div>
  );
}
