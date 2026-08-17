"use client";

import {
  AI_PLAN_MONTHLY_USAGE_LIMIT_KEY,
  aiPriceSettingKey,
  derivePlanUnitValue,
  describeAllowanceEquivalent,
  formatAmount,
  formatFractionalAmount,
  isZeroDecimalCurrency,
  operationAmount,
  type AiAllowanceEquivalent,
  type AiUnitValue,
} from "@beutl/core";
import type { AiCostAssumption, AiCostEstimate } from "@beutl/api";
import { useTranslation } from "@beutl/ui/i18n-client";
import { Badge } from "@beutl/ui/ui/badge";
import { formatNumber } from "@/lib/format";
import { useAiSettingField } from "./settings-form";

// These panels run on the client so the figures follow the fields as they are
// typed. Everything they compute is a pure function from @beutl/core; the
// server only supplies what needs the network — the provider cost estimate and
// the Stripe prices — neither of which changes with an unsaved edit.

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

function formatAllowanceQuantity(
  entry: AiAllowanceEquivalent,
  lang: string,
  t: Translator,
): string {
  return `${formatNumber(entry.quantity.value, lang)} ${t(
    `admin:ai.economics.quantity.${entry.quantity.kind}`,
  )}`;
}

function formatUsd(value: number): string {
  // Provider prices span four orders of magnitude, from $0.0002 a minute to
  // $0.40 a second, so the precision follows the magnitude.
  const digits = value >= 0.1 ? 2 : value >= 0.001 ? 4 : 6;
  return `$${value.toFixed(digits)}`;
}

function formatCostRange(estimate: AiCostEstimate, t: Translator): string {
  if (estimate.status === "unknown") {
    return t(`admin:ai.economics.costUnknown.${estimate.reason}`);
  }
  return estimate.usdMin === estimate.usdMax
    ? formatUsd(estimate.usdMin)
    : `${formatUsd(estimate.usdMin)} – ${formatUsd(estimate.usdMax)}`;
}

function describeAssumption(
  assumption: AiCostAssumption,
  lang: string,
  t: Translator,
): string {
  switch (assumption.kind) {
    case "translationTokensPerCharacter":
      return t("admin:ai.economics.assumption.translationTokens", {
        min: assumption.min,
        max: assumption.max,
      });
    case "transcriptionMinute":
      return t("admin:ai.economics.assumption.transcriptionMinute");
    case "videoSku":
      return t("admin:ai.economics.assumption.videoSku", {
        sku: assumption.value,
      });
    case "imageMegapixels":
      return t("admin:ai.economics.assumption.imageMegapixels");
    case "imageInputNotPriced":
      return t("admin:ai.economics.assumption.imageInputNotPriced");
    default:
      return t("admin:ai.economics.assumption.imageTokens", {
        tokens: formatNumber(assumption.value, lang),
      });
  }
}

// Cost as a share of revenue, only when both are in the same currency. There is
// no exchange rate anywhere in this codebase and inventing one would put a
// number on screen that nobody maintains — but the panel says so rather than
// leaving the figure out, because a store priced in anything but USD would
// otherwise show no cost ratio at all and no reason for its absence.
type CostRatio =
  | { status: "ratio"; percent: number }
  | { status: "foreignCurrency"; currency: string }
  | { status: "unavailable" };

function costRatioOf(
  estimate: AiCostEstimate | undefined,
  revenue: { minorUnits: number; currency: string } | null,
): CostRatio {
  if (!estimate || estimate.status !== "estimated" || !revenue) {
    return { status: "unavailable" };
  }
  if (revenue.currency.toLowerCase() !== "usd") {
    return { status: "foreignCurrency", currency: revenue.currency };
  }
  // Provider costs are quoted in whole dollars, so the revenue has to be read
  // the same way. A zero-decimal currency stores no minor units to divide out.
  const revenueUsd = isZeroDecimalCurrency(revenue.currency)
    ? revenue.minorUnits
    : revenue.minorUnits / 100;
  if (!(revenueUsd > 0)) return { status: "unavailable" };
  return {
    status: "ratio",
    percent: Math.round((estimate.usdMax / revenueUsd) * 100),
  };
}

// A bar makes "is this price out of line" readable at a glance, which a bare
// percentage does not. At or over 100% the operation loses money.
function CostRatioBar({ percent, label }: { percent: number; label: string }) {
  const overBudget = percent >= 100;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-full max-w-24 overflow-hidden rounded-full bg-muted">
        <div
          className={
            overBudget
              ? "h-full rounded-full bg-destructive transition-all"
              : percent >= 60
                ? "h-full rounded-full bg-amber-500 transition-all"
                : "h-full rounded-full bg-emerald-500 transition-all"
          }
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </div>
      <span
        className={
          overBudget
            ? "tabular-nums font-medium text-destructive"
            : "tabular-nums font-medium"
        }
      >
        {percent}%
      </span>
      <span className="sr-only">{label}</span>
    </div>
  );
}

function Figure({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{children}</dd>
    </div>
  );
}

// A cost ratio with the revenue it was measured against, so the percentage can
// be traced back to a figure rather than being taken on faith.
function RatioFigure({
  lang,
  label,
  revenueLabel,
  percent,
  revenue,
}: {
  lang: string;
  label: string;
  revenueLabel: string;
  percent: number;
  revenue: { minorUnits: number; currency: string } | null;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="flex flex-col gap-0.5 text-sm font-medium">
        <CostRatioBar percent={percent} label={label} />
        {revenue && (
          <span className="text-xs font-normal text-muted-foreground">
            {revenueLabel}{" "}
            {formatFractionalAmount(revenue.minorUnits, revenue.currency, lang)}
          </span>
        )}
      </dd>
    </div>
  );
}

export function AiOperationEconomicsPanel({
  lang,
  operation,
  estimate,
  proOffer,
  topUpUnitValue,
}: {
  lang: string;
  operation: string;
  // Undefined while the estimates are still loading; null-ish states inside the
  // estimate itself are distinct from that.
  estimate: AiCostEstimate | undefined;
  proOffer: OfferAmount;
  topUpUnitValue: AiUnitValue | null;
}) {
  const { t } = useTranslation(lang);
  const priceField = useAiSettingField(aiPriceSettingKey(operation));
  const limitField = useAiSettingField(AI_PLAN_MONTHLY_USAGE_LIMIT_KEY);

  const price = usableNumber(priceField.value);
  const allowance = usableNumber(limitField.value);
  const previewing = priceField.changed || limitField.changed;

  const equivalent =
    price !== null && allowance !== null
      ? describeAllowanceEquivalent({
          operation,
          allowanceUnits: allowance,
          price,
        })
      : null;

  // The allowance divides the subscription price, so editing it moves the plan
  // rate as well as the quantity.
  const planUnitValue =
    allowance !== null ? derivePlanUnitValue(proOffer, allowance) : null;
  const planRevenue = price !== null ? operationAmount(planUnitValue, price) : null;
  const topUpRevenue =
    price !== null ? operationAmount(topUpUnitValue, price) : null;
  const planRatio = costRatioOf(estimate, planRevenue);
  const topUpRatio = costRatioOf(estimate, topUpRevenue);
  const foreignCurrency =
    planRatio.status === "foreignCurrency"
      ? planRatio.currency
      : topUpRatio.status === "foreignCurrency"
        ? topUpRatio.currency
        : null;

  const assumptions =
    estimate?.status === "estimated"
      ? estimate.assumptions.map((assumption) =>
          describeAssumption(assumption, lang, t),
        )
      : [];

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-4">
      {previewing && (
        <div>
          <Badge variant="secondary">{t("admin:ai.economics.preview")}</Badge>
        </div>
      )}
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label={t("admin:ai.economics.allowanceBuys")}>
          {!equivalent ? (
            "-"
          ) : equivalent.affordable ? (
            formatAllowanceQuantity(equivalent, lang, t)
          ) : (
            <span className="text-destructive">
              {t("admin:ai.economics.unaffordable")}
            </span>
          )}
        </Figure>

        <Figure label={t("admin:ai.economics.providerCost")}>
          {!estimate ? (
            <span className="text-xs font-normal text-muted-foreground">
              {t("admin:ai.economics.loading")}
            </span>
          ) : estimate.status === "estimated" ? (
            formatCostRange(estimate, t)
          ) : (
            <span className="text-xs font-normal text-muted-foreground">
              {formatCostRange(estimate, t)}
            </span>
          )}
        </Figure>

        {planRatio.status === "ratio" && (
          <RatioFigure
            lang={lang}
            label={t("admin:ai.economics.costRatioPlan")}
            revenueLabel={t("admin:ai.economics.revenueHint")}
            percent={planRatio.percent}
            revenue={planRevenue}
          />
        )}

        {topUpRatio.status === "ratio" && (
          <RatioFigure
            lang={lang}
            label={t("admin:ai.economics.costRatioTopUp")}
            revenueLabel={t("admin:ai.economics.revenueHint")}
            percent={topUpRatio.percent}
            revenue={topUpRevenue}
          />
        )}
      </dl>

      {foreignCurrency && (
        <p className="text-xs text-muted-foreground">
          {t("admin:ai.economics.costRatioForeignCurrency", {
            currency: foreignCurrency.toUpperCase(),
          })}
        </p>
      )}

      {assumptions.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("admin:ai.economics.assumptionsLabel")} {assumptions.join(" / ")}
        </p>
      )}
    </div>
  );
}

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
