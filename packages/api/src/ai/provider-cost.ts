// Provider-reported request cost, normalized without trusting an untyped
// metadata object. Costs are USD and may be numbers or decimal strings.

export function providerCostUsd(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") {
    return undefined;
  }
  if (typeof value === "string" && value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function gatewayProviderCostUsd(
  providerMetadata: unknown,
): number | undefined {
  if (typeof providerMetadata !== "object" || providerMetadata === null) {
    return undefined;
  }
  const gateway = (providerMetadata as Record<string, unknown>).gateway;
  if (typeof gateway !== "object" || gateway === null) return undefined;
  return providerCostUsd((gateway as Record<string, unknown>).cost);
}

export function withProviderCost<T extends object>(
  value: T,
  costUsd: number | undefined,
): T & { providerCostUsd?: number } {
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
