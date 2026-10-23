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
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function requestFor(country?: string) {
  const headers = new Headers({ "x-real-ip": "203.0.113.1" });
  if (country) headers.set("CF-IPCountry", country);
  mocks.headers.mockResolvedValue(headers);
  return new Request("https://example.test/store", { headers });
}

describe("country-based currency selection", () => {
  it.each([
    "example.com", "203.0.113.1/json", "203.0.113.1?token=other",
    "203.0.113.1#fragment", "../json", "999.1.2.3", "127.1",
    "[2001:db8::1]", "2001:db8::xyz", "fe80::1%eth0",
  ])("never sends an invalid IP to ipinfo (%s)", async (ip) => {
    vi.stubEnv("IPINFO_TOKEN", "test-token");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const header of ["cf-connecting-ip", "x-real-ip", "x-forwarded-for"]) {
      const headers = new Headers({ [header]: ip });
      mocks.headers.mockResolvedValue(headers);
      expect(await guessWebCurrency()).toBeNull();
      expect(await guessApiCurrency(new Request("https://example.test", { headers }))).toBeNull();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["x-real-ip", "203.0.113.1", "203.0.113.1"],
    ["cf-connecting-ip", "2001:db8::1", "2001:db8::1"],
    ["x-forwarded-for", " 2001:db8::1 , 203.0.113.2", "2001:db8::1"],
    ["x-real-ip", "::ffff:192.0.2.1", "::ffff:192.0.2.1"],
  ])("looks up a valid address from %s", async (header, ip, expected) => {
    vi.stubEnv("IPINFO_TOKEN", "test-token");
    const fetch = vi.fn(async () => Response.json({ country: "JP" }));
    vi.stubGlobal("fetch", fetch);
    const headers = new Headers({ [header]: ip });
    mocks.headers.mockResolvedValue(headers);
    expect(await guessWebCurrency()).toBe("JPY");
    expect(await guessApiCurrency(new Request("https://example.test", { headers }))).toBe("JPY");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith(`https://ipinfo.io/${expected}`, {
      headers: { Authorization: "Bearer test-token" },
    });
  });

  it("prefers Cloudflare's address to client-supplied forwarding headers", async () => {
    vi.stubEnv("IPINFO_TOKEN", "test-token");
    const fetch = vi.fn(async () => Response.json({ country: "US" }));
    vi.stubGlobal("fetch", fetch);
    const headers = new Headers({
      "cf-connecting-ip": "203.0.113.1",
      "x-real-ip": "198.51.100.1",
      "x-forwarded-for": "192.0.2.1",
    });
    mocks.headers.mockResolvedValue(headers);
    expect(await guessWebCurrency()).toBe("USD");
    expect(await guessApiCurrency(new Request("https://example.test", { headers }))).toBe("USD");
    expect(fetch.mock.calls.every(([url]) => url === "https://ipinfo.io/203.0.113.1")).toBe(true);
  });

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
