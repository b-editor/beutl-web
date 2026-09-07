import { beforeEach, describe, expect, it } from "vitest";
import {
  activateBillingOffer,
  findCheckoutBillingOffer,
  listBillingOfferPriceIds,
  setDbProvider,
  type BillingOfferTerms,
} from "@beutl/db";

// Storage sells one offer per tier, so the "one enabled offer per kind" rule
// becomes "one per (kind, tier)" and must never disable a Pro offer.
describe("storage billing offers", () => {
  const offers = new Map<string, any>();
  let nextId = 1;

  beforeEach(() => {
    offers.clear();
    nextId = 1;
    const billingOffer = {
      findUnique: async ({ where }: any) => {
        if (where.stripePriceId) {
          return [...offers.values()].find(
            (offer) => offer.stripePriceId === where.stripePriceId,
          ) ?? null;
        }
        return offers.get(where.id) ?? null;
      },
      findMany: async ({ where }: any) =>
        [...offers.values()].filter(
          (offer) =>
            offer.kind === where.kind &&
            (where.tier === undefined || offer.tier === where.tier),
        ),
      findFirst: async ({ where }: any) =>
        [...offers.values()].find(
          (offer) =>
            offer.kind === where.kind &&
            offer.checkoutEnabled === where.checkoutEnabled &&
            (where.tier === undefined || offer.tier === where.tier),
        ) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const existing = [...offers.values()].find(
          (offer) => offer.stripePriceId === where.stripePriceId,
        );
        if (existing) {
          const offer = { ...existing, ...update };
          offers.set(offer.id, offer);
          return { ...offer };
        }
        const offer = { id: `offer-${nextId++}`, tier: null, ...create };
        offers.set(offer.id, offer);
        return { ...offer };
      },
      update: async ({ where, data }: any) => {
        const offer = { ...offers.get(where.id), ...data };
        offers.set(where.id, offer);
        return { ...offer };
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const [id, offer] of offers) {
          if (
            offer.kind === where.kind &&
            offer.checkoutEnabled === where.checkoutEnabled &&
            id !== where.id.not &&
            (where.tier === undefined || offer.tier === where.tier)
          ) {
            offers.set(id, { ...offer, ...data });
            count++;
          }
        }
        return { count };
      },
    };
    const prisma = {
      billingOffer,
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        await callback(prisma),
    };
    setDbProvider(async () => prisma as never);
  });

  const storageTerms = (
    stripePriceId: string,
    tier: BillingOfferTerms["tier"],
    overrides: Partial<BillingOfferTerms> = {},
  ): BillingOfferTerms => ({
    kind: "storage",
    stripePriceId,
    stripeProductId: `prod_${tier}`,
    unitAmount: 500,
    currency: "usd",
    creditAmount: null,
    recurringInterval: "month",
    recurringIntervalCount: 1,
    tier,
    ...overrides,
  });

  const proTerms = (stripePriceId: string): BillingOfferTerms => ({
    kind: "pro",
    stripePriceId,
    stripeProductId: "prod_pro",
    unitAmount: 2_000,
    currency: "usd",
    creditAmount: null,
    recurringInterval: "month",
    recurringIntervalCount: 1,
  });

  it("keeps one enabled offer per tier", async () => {
    await activateBillingOffer({ terms: storageTerms("price_100_v1", "100gb") });
    await activateBillingOffer({ terms: storageTerms("price_200_v1", "200gb") });
    expect((await findCheckoutBillingOffer({ kind: "storage", tier: "100gb" }))?.stripePriceId).toBe("price_100_v1");
    expect((await findCheckoutBillingOffer({ kind: "storage", tier: "200gb" }))?.stripePriceId).toBe("price_200_v1");

    await activateBillingOffer({ terms: storageTerms("price_100_v2", "100gb", { unitAmount: 600 }) });
    expect((await findCheckoutBillingOffer({ kind: "storage", tier: "100gb" }))?.stripePriceId).toBe("price_100_v2");
    expect((await findCheckoutBillingOffer({ kind: "storage", tier: "200gb" }))?.stripePriceId).toBe("price_200_v1");
    expect(await listBillingOfferPriceIds({ kind: "storage" })).toEqual(
      expect.arrayContaining(["price_100_v1", "price_100_v2", "price_200_v1"]),
    );
    expect(await listBillingOfferPriceIds({ kind: "storage", tier: "200gb" })).toEqual(["price_200_v1"]);
  });

  it("never disables a Pro offer when a storage offer rotates", async () => {
    await activateBillingOffer({ terms: proTerms("price_pro") });
    await activateBillingOffer({ terms: storageTerms("price_1tb", "1tb") });
    expect((await findCheckoutBillingOffer({ kind: "pro" }))?.stripePriceId).toBe("price_pro");
    await activateBillingOffer({ terms: proTerms("price_pro_v2") });
    expect((await findCheckoutBillingOffer({ kind: "storage", tier: "1tb" }))?.stripePriceId).toBe("price_1tb");
  });

  it("rejects malformed storage terms", async () => {
    await expect(
      activateBillingOffer({ terms: storageTerms("p1", null) }),
    ).rejects.toThrow(/known tier/);
    await expect(
      activateBillingOffer({ terms: storageTerms("p2", "100gb", { creditAmount: 5 }) }),
    ).rejects.toThrow();
    await expect(
      activateBillingOffer({ terms: storageTerms("p3", "100gb", { recurringInterval: "year" }) }),
    ).rejects.toThrow();
    await expect(
      activateBillingOffer({ terms: { ...proTerms("p4"), tier: "100gb" } }),
    ).rejects.toThrow(/has no tiers/);
  });

  it("re-activates an existing Pro row whose terms omit the tier", async () => {
    await activateBillingOffer({ terms: proTerms("price_pro") });
    await expect(activateBillingOffer({ terms: proTerms("price_pro") })).resolves.toMatchObject({
      stripePriceId: "price_pro",
      checkoutEnabled: true,
    });
  });

  it("refuses a storage price re-recorded under another tier", async () => {
    await activateBillingOffer({ terms: storageTerms("price_shared", "100gb") });
    await expect(
      activateBillingOffer({ terms: storageTerms("price_shared", "200gb", { stripeProductId: "prod_100gb" }) }),
    ).rejects.toThrow(/conflicts/);
  });
});
