// What a monthly allowance actually buys, and what one usage unit is worth.
//
// The allowance-equivalent and revenue figures in this file are for the admin
// console only. The fixed-precision conversion helpers are also used by the
// billing path, but none of those amounts are exposed to ordinary clients.
//
// Pure functions with no I/O, so the admin console can compute them during
// server rendering and, later, preview an unsaved value in the browser.
import { AI_PRICING_CATALOG, type AiBillingUnit } from "./ai-pricing-catalog";
import { decimalFraction } from "./decimal-arithmetic";

// The quantity an administrator thinks in, which is not always the billing
// unit: a thousand characters is billed as one unit but read as 1,000.
export type AiAllowanceQuantityKind =
  | "request"
  | "second"
  | "minute"
  | "character";

const QUANTITY_PER_BILLING_UNIT: Record<
  AiBillingUnit,
  { kind: AiAllowanceQuantityKind; multiplier: number }
> = {
  request: { kind: "request", multiplier: 1 },
  second: { kind: "second", multiplier: 1 },
  started_minute: { kind: "minute", multiplier: 1 },
  started_1000_characters: { kind: "character", multiplier: 1000 },
};

export type AiAllowanceEquivalent = {
  operation: string;
  unit: AiBillingUnit;
  price: number;
  // How many chargeable units the allowance covers. Always floored: a partial
  // unit cannot be started, so reporting 12.5 seconds would name a video the
  // plan cannot actually produce.
  billingUnits: number;
  quantity: {
    kind: AiAllowanceQuantityKind;
    value: number;
  };
  // False when the smallest request the entry point accepts already costs more
  // than the allowance, which for video is the minimum supported duration.
  affordable: boolean;
};

function isUsableAmount(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export const USD_MICROS_PER_DOLLAR = 1_000_000;
export const USAGE_UNIT_MICROS_PER_UNIT = 1_000_000;
// Preserve the former INT4 range while allowing six fractional places. Keeping
// the scaled value below Number.MAX_SAFE_INTEGER lets every application layer
// round-trip a database DECIMAL without losing a micro-unit.
export const MAX_USAGE_UNITS = 2_147_483_647;

/** Normalize a usage-unit value to the six decimal places stored by the ledger. */
export function normalizeUsageUnits(value: number): number | null {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_USAGE_UNITS) {
    return null;
  }
  const scaled = Math.round(value * USAGE_UNIT_MICROS_PER_UNIT);
  if (!Number.isSafeInteger(scaled)) return null;
  return scaled / USAGE_UNIT_MICROS_PER_UNIT;
}

/** Round a positive charge up so conversion never undercharges provider cost. */
export function ceilUsageUnits(value: number): number | null {
  if (!Number.isFinite(value) || value < 0 || value > MAX_USAGE_UNITS) {
    return null;
  }
  const { numerator, denominator } = decimalFraction(value);
  const scaled = (
    numerator * BigInt(USAGE_UNIT_MICROS_PER_UNIT) + denominator - BigInt(1)
  ) / denominator;
  return Number(scaled) / USAGE_UNIT_MICROS_PER_UNIT;
}

/** Provider-reported USD cost rounded up to the ledger's micro-unit. */
export function usageUnitsForProviderCost(
  costUsd: number,
  usdPerUsageUnit: number,
  usagePercent = 100,
): number | null {
  if (
    !Number.isFinite(costUsd) ||
    costUsd < 0 ||
    !isUsableAmount(usdPerUsageUnit) ||
    !Number.isSafeInteger(usagePercent) ||
    usagePercent <= 0
  ) {
    return null;
  }
  if (costUsd === 0) return 0;
  const cost = decimalFraction(costUsd);
  const rate = decimalFraction(usdPerUsageUnit);
  // Round once, after conversion and the model percentage. All intermediate
  // arithmetic stays exact, including scientific notation and repeating ratios.
  const numerator =
    cost.numerator *
    rate.denominator *
    BigInt(usagePercent) *
    BigInt(USAGE_UNIT_MICROS_PER_UNIT);
  const denominator = cost.denominator * rate.numerator * BigInt(100);
  const usageMicros = (numerator + denominator - BigInt(1)) / denominator;
  if (
    usageMicros >
      BigInt(MAX_USAGE_UNITS) * BigInt(USAGE_UNIT_MICROS_PER_UNIT)
  ) {
    return null;
  }
  return Number(usageMicros) / USAGE_UNIT_MICROS_PER_UNIT;
}

export function describeAllowanceEquivalent({
  operation,
  allowanceUnits,
  price,
}: {
  operation: string;
  allowanceUnits: number;
  price: number;
}): AiAllowanceEquivalent | null {
  if (!Object.hasOwn(AI_PRICING_CATALOG, operation)) {
    return null;
  }
  const unit =
    AI_PRICING_CATALOG[operation as keyof typeof AI_PRICING_CATALOG].unit;
  const quantity = QUANTITY_PER_BILLING_UNIT[unit];

  // A missing or nonsensical price must not turn into Infinity downstream.
  if (!isUsableAmount(allowanceUnits) || !isUsableAmount(price)) {
    return {
      operation,
      unit,
      price: isUsableAmount(price) ? price : 0,
      billingUnits: 0,
      quantity: { kind: quantity.kind, value: 0 },
      affordable: false,
    };
  }

  const billingUnits = Math.floor(allowanceUnits / price);
  const minimumQuantity =
    AI_PRICING_CATALOG[operation as keyof typeof AI_PRICING_CATALOG]
      .minimumQuantity;
  return {
    operation,
    unit,
    price,
    billingUnits,
    quantity: {
      kind: quantity.kind,
      value: billingUnits * quantity.multiplier,
    },
    affordable: billingUnits >= minimumQuantity,
  };
}

// priceOf is a callback so an AiSettingsSnapshot can be passed straight in
// without @beutl/core depending on @beutl/api.
export function describeAllowanceEquivalents({
  allowanceUnits,
  priceOf,
}: {
  allowanceUnits: number;
  priceOf: (operation: string) => number;
}): AiAllowanceEquivalent[] {
  return Object.keys(AI_PRICING_CATALOG).map(
    (operation) =>
      describeAllowanceEquivalent({
        operation,
        allowanceUnits,
        price: priceOf(operation),
      })!,
  );
}

// What one usage unit is worth, in the minor currency units Stripe stores.
// Fractional by nature, so it is kept as a number and only rounded at render.
export type AiUnitValue = {
  minorUnitsPerUnit: number;
  currency: string;
};

type BillingOfferAmount = {
  unitAmount: number;
  currency: string;
  creditAmount: number | null;
};

// What a customer pays per unit when topping up. This is the marginal rate
// actually charged, so it is a fact rather than an allocation.
export function deriveTopUpUnitValue(
  offer: BillingOfferAmount | null | undefined,
): AiUnitValue | null {
  if (!offer || !isUsableAmount(offer.unitAmount)) {
    return null;
  }
  const credits = offer.creditAmount;
  if (credits === null || !isUsableAmount(credits)) {
    return null;
  }
  return {
    minorUnitsPerUnit: offer.unitAmount / credits,
    currency: offer.currency,
  };
}

// What the plan earns per unit from a subscriber who spends the whole
// allowance. This is the floor of Pro revenue per unit and the figure a
// provider cost should be compared against.
export function derivePlanUnitValue(
  offer: BillingOfferAmount | null | undefined,
  allowanceUnits: number,
): AiUnitValue | null {
  if (!offer || !isUsableAmount(offer.unitAmount)) {
    return null;
  }
  if (!isUsableAmount(allowanceUnits)) {
    return null;
  }
  return {
    minorUnitsPerUnit: offer.unitAmount / allowanceUnits,
    currency: offer.currency,
  };
}

// The revenue one chargeable unit of an operation represents at a given rate.
export function operationAmount(
  unitValue: AiUnitValue | null,
  price: number,
): { minorUnits: number; currency: string } | null {
  if (!unitValue || !isUsableAmount(price)) {
    return null;
  }
  return {
    minorUnits: unitValue.minorUnitsPerUnit * price,
    currency: unitValue.currency,
  };
}
