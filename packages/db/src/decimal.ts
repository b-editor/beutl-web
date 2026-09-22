import { normalizeUsageUnits } from "@beutl/core";
import { Prisma } from "@prisma/client";

type DecimalAsNumber<T> = T extends Prisma.Decimal ? number : T;

export type DecimalNumbers<T> = {
  [K in keyof T]: DecimalAsNumber<T[K]>;
};

// Prisma returns DECIMAL columns as Decimal.js values. The public database
// package keeps its existing number contract, after proving the value fits the
// ledger's six-place fixed precision and safe JavaScript range.
export function decimalNumber(value: Prisma.Decimal | number): number {
  const numeric = typeof value === "number" ? value : value.toNumber();
  const normalized = normalizeUsageUnits(numeric);
  if (normalized === null) {
    throw new RangeError("Usage-unit decimal is outside the supported range");
  }
  return normalized;
}

export function decimalNumbers<T extends object>(value: T): DecimalNumbers<T> {
  const result = { ...value } as Record<string, unknown>;
  for (const [key, entry] of Object.entries(result)) {
    if (Prisma.Decimal.isDecimal(entry)) {
      result[key] = decimalNumber(entry);
    }
  }
  return result as DecimalNumbers<T>;
}

export function decimalNumberRows<T extends object>(
  values: readonly T[],
): DecimalNumbers<T>[] {
  return values.map(decimalNumbers);
}
