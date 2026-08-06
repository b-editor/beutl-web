export function selectPricing<T extends { currency: string; fallback: boolean }>(
  pricings: T[] | undefined | null,
  currency?: string | null,
): T | undefined {
  if (!pricings) return undefined;
  return (
    pricings.find((p) => p.currency === currency) ||
    pricings.find((p) => p.fallback) ||
    pricings[0]
  );
}
