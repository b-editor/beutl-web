import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ headers: vi.fn() }));
vi.mock("next/headers", () => ({ headers: mocks.headers }));

import { guessCurrency as guessWebCurrency } from "../../apps/web/src/lib/currency";
import { guessCurrency as guessApiCurrency } from "../../packages/api/src/currency";
import { selectPricing } from "../../packages/core/src/pricing";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("IPINFO_TOKEN", "");
});
afterEach(() => vi.unstubAllEnvs());

function requestFor(country?: string) {
  const headers = new Headers({ "x-real-ip": "203.0.113.1" });
  if (country) headers.set("CF-IPCountry", country);
  mocks.headers.mockResolvedValue(headers);
  return new Request("https://example.test/store", { headers });
}

describe("country-based currency selection", () => {
  it.each([
    ["JP", "JPY"], ["US", "USD"], ["GB", "GBP"],
    ["CW", "XCG"], ["SX", "XCG"], ["VE", "VES"],
  ])("uses the current currency for %s in Web and API", async (country, currency) => {
    const request = requestFor(country);
    expect(await guessWebCurrency()).toBe(currency);
    expect(await guessApiCurrency(request)).toBe(currency);
  });

  it.each(["ZZ", undefined])("handles an unknown country (%s)", async (country) => {
    const request = requestFor(country);
    expect(await guessWebCurrency()).toBeNull();
    expect(await guessApiCurrency(request)).toBeNull();
  });

  it.each(["CW", "SX", "VE"])("keeps the configured fallback price when %s has no matching price", async (country) => {
    const request = requestFor(country);
    const fallback = { currency: "USD", price: 500, fallback: true };
    const prices = [{ currency: "JPY", price: 750, fallback: false }, fallback];
    expect(selectPricing(prices, await guessWebCurrency())).toBe(fallback);
    expect(selectPricing(prices, await guessApiCurrency(request))).toBe(fallback);
  });

  it("selects a matching price in its declared currency", async () => {
    const request = requestFor("CW");
    const matching = { currency: "XCG", price: 900, fallback: false };
    const prices = [{ currency: "USD", price: 500, fallback: true }, matching];
    expect(selectPricing(prices, await guessWebCurrency())).toBe(matching);
    expect(selectPricing(prices, await guessApiCurrency(request))).toBe(matching);
  });
});
