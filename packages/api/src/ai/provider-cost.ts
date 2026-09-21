// Provider-reported request cost, normalized without trusting an untyped
// metadata object. Costs are USD and may be numbers or decimal strings.
import { parseNonNegativeDecimalFraction } from "@beutl/core";

export type ProviderCostUsd = number | string;

export function providerCostUsd(value: unknown): ProviderCostUsd | undefined {
  if (typeof value !== "number" && typeof value !== "string") {
    return undefined;
  }
  if (parseNonNegativeDecimalFraction(value) === null) return undefined;
  // Preserve provider-supplied digits until the final micro-unit rounding.
  return typeof value === "string" ? value.trim() : value;
}

export function gatewayProviderCostUsd(
  providerMetadata: unknown,
): ProviderCostUsd | undefined {
  if (typeof providerMetadata !== "object" || providerMetadata === null) {
    return undefined;
  }
  const gateway = (providerMetadata as Record<string, unknown>).gateway;
  if (typeof gateway !== "object" || gateway === null) return undefined;
  return providerCostUsd((gateway as Record<string, unknown>).cost);
}

export function withProviderCost<T extends object>(
  value: T,
  costUsd: ProviderCostUsd | undefined,
): T & { providerCostUsd?: ProviderCostUsd } {
  if (costUsd !== undefined) {
    Object.defineProperty(value, "providerCostUsd", {
      value: costUsd,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return value;
}
