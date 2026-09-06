import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDbProvider } from "@beutl/db";
import { resolveOfferPricing } from "../../apps/admin/src/lib/stripe-pricing";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const PRO_PRICE_ID = "price_pro_test";
const TOP_UP_PRICE_ID = "price_topup_test";

function storedOffer(overrides: Record<string, unknown> = {}) {
  return {
    id: "offer-1",
    kind: "pro",
    stripePriceId: PRO_PRICE_ID,
    stripeProductId: "prod_test",
    unitAmount: 1480,
    currency: "usd",
    creditAmount: null,
    recurringInterval: "month",
    recurringIntervalCount: 1,
    checkoutEnabled: true,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

// A Pro Price is monthly by contract — normalizeTerms refuses to record an
// offer that is not — so a fixture standing in for one has to carry that shape.
function proPrice(overrides: Record<string, unknown> = {}) {
  return {
    id: PRO_PRICE_ID,
    unit_amount: 1980,
    currency: "usd",
    recurring: { interval: "month", interval_count: 1 },
    ...overrides,
  };
}

function stripeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("admin Stripe price resolution", () => {
  let state: ReturnType<typeof createInMemoryPrisma>["state"];

  beforeEach(() => {
    const memory = createInMemoryPrisma();
    state = memory.state;
    setDbProvider(async () => memory.prisma as never);
    vi.stubEnv("STRIPE_PRO_PRICE_ID", PRO_PRICE_ID);
    vi.stubEnv("STRIPE_CREDIT_PRICE_ID", TOP_UP_PRICE_ID);
    // Start every case from "no key configured" so a key in the developer's own
    // environment cannot change what these tests exercise.
    vi.stubEnv("STRIPE_SECRET_KEY", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("reads the live price from Stripe", async () => {
    const fetchMock = vi.fn(async () =>
      stripeResponse(proPrice({ currency: "USD" })),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("STRIPE_SECRET_KEY", "rk_test_readonly");

    const result = await resolveOfferPricing({ kind: "pro" });

    expect(result.source).toBe("stripe");
    expect(result.effective).toEqual({
      stripePriceId: PRO_PRICE_ID,
      unitAmount: 1980,
      currency: "usd",
      creditAmount: null,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.stripe.com/v1/prices/${PRO_PRICE_ID}`);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer rk_test_readonly",
    );
  });

  it("fills in the units a top-up grants, which Stripe does not know", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        stripeResponse({
          id: TOP_UP_PRICE_ID,
          unit_amount: 500,
          currency: "usd",
        }),
      ),
    );
    vi.stubEnv("STRIPE_SECRET_KEY", "rk_test_readonly");

    const result = await resolveOfferPricing({ kind: "top_up" });
    expect(result.effective?.creditAmount).toBe(500);
  });

  it("falls back to the recorded offer when no key is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    state.billingOffers.set("offer-1", storedOffer());

    const result = await resolveOfferPricing({ kind: "pro" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.source).toBe("database");
    expect(result.stripeError).toBe("notConfigured");
    expect(result.effective?.unitAmount).toBe(1480);
  });

  it("falls back to the recorded offer when Stripe is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    vi.stubEnv("STRIPE_SECRET_KEY", "rk_test_readonly");
    state.billingOffers.set("offer-1", storedOffer());

    const result = await resolveOfferPricing({ kind: "pro" });
    expect(result.source).toBe("database");
    expect(result.stripeError).toBe("unavailable");
  });

  it("flags a price that was edited in Stripe after the offer was recorded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        stripeResponse(proPrice()),
      ),
    );
    vi.stubEnv("STRIPE_SECRET_KEY", "rk_test_readonly");
    state.billingOffers.set("offer-1", storedOffer({ unitAmount: 1480 }));

    const result = await resolveOfferPricing({ kind: "pro" });
    expect(result.mismatch).toBe(true);
    // Stripe still wins for display; purchases settle on the stored terms.
    expect(result.effective?.unitAmount).toBe(1980);
  });

  it.each([
    ["a missing price", stripeResponse({ error: "no such price" }, 404), "notFound"],
    [
      "a metered price with no unit amount",
      stripeResponse(proPrice({ unit_amount: null })),
      "unavailable",
    ],
    [
      "a server error",
      stripeResponse({ error: "boom" }, 500),
      "unavailable",
    ],
    // A yearly amount divided by the monthly allowance reports twelve times the
    // revenue a subscriber actually produces, which is the figure the operator
    // sets unit prices against.
    [
      "a Pro price that is not billed monthly",
      stripeResponse(
        proPrice({ recurring: { interval: "year", interval_count: 1 } }),
      ),
      "notFound",
    ],
    [
      "a Pro price that is not recurring at all",
      stripeResponse(proPrice({ recurring: null })),
      "notFound",
    ],
  ])("reports %s without an offer to fall back on", async (_label, response, reason) => {
    vi.stubGlobal("fetch", vi.fn(async () => response));
    vi.stubEnv("STRIPE_SECRET_KEY", "rk_test_readonly");

    const result = await resolveOfferPricing({ kind: "pro" });
    expect(result.effective).toBeNull();
    expect(result.source).toBeNull();
    expect(result.stripeError).toBe(reason);
  });

  it("ignores an offer that is no longer the checkout target", async () => {
    vi.stubGlobal("fetch", vi.fn());
    state.billingOffers.set(
      "offer-1",
      storedOffer({ checkoutEnabled: false }),
    );

    const result = await resolveOfferPricing({ kind: "pro" });
    expect(result.effective).toBeNull();
    expect(result.hasDatabaseOffer).toBe(false);
  });
});
