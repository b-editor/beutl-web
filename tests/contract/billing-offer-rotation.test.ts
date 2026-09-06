import { beforeEach, describe, expect, it } from "vitest";
import {
  activateBillingOffer,
  listBillingOfferPriceIds,
  registerHistoricalBillingOffer,
  setDbProvider,
  type BillingOfferTerms,
} from "@beutl/db";

describe("versioned billing offers", () => {
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
        [...offers.values()].filter((offer) => offer.kind === where.kind),
      create: async ({ data }: any) => {
        const offer = { id: `offer-${nextId++}`, ...data };
        offers.set(offer.id, offer);
        return { ...offer };
      },
      upsert: async ({ where, create, update }: any) => {
        const existing = [...offers.values()].find(
          (offer) => offer.stripePriceId === where.stripePriceId,
        );
        if (existing) {
          const offer = { ...existing, ...update };
          offers.set(offer.id, offer);
          return { ...offer };
        }
        const offer = { id: `offer-${nextId++}`, ...create };
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
            id !== where.id.not
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

  const proTerms = (stripePriceId: string): BillingOfferTerms => ({
    kind: "pro",
    stripePriceId,
    stripeProductId: "prod_pro",
    unitAmount: stripePriceId.endsWith("v1") ? 2_000 : 2_500,
    currency: "usd",
    creditAmount: null,
    recurringInterval: "month",
    recurringIntervalCount: 1,
  });

  it("rotates checkout without deleting the historical Price identity", async () => {
    const first = await activateBillingOffer({ terms: proTerms("price_v1") });
    const second = await activateBillingOffer({ terms: proTerms("price_v2") });

    expect(offers.get(first.id)).toMatchObject({
      stripePriceId: "price_v1",
      checkoutEnabled: false,
    });
    expect(offers.get(second.id)).toMatchObject({
      stripePriceId: "price_v2",
      checkoutEnabled: true,
    });
    await expect(listBillingOfferPriceIds({ kind: "pro" })).resolves.toEqual([
      "price_v1",
      "price_v2",
    ]);
  });

  it("rejects mutation of immutable terms for an existing Stripe Price", async () => {
    await activateBillingOffer({ terms: proTerms("price_v1") });

    await expect(
      activateBillingOffer({
        terms: { ...proTerms("price_v1"), unitAmount: 9_999 },
      }),
    ).rejects.toThrow("conflicts with its persisted billing offer");
  });

  it("registers a historical Price without changing the active checkout offer", async () => {
    const current = await activateBillingOffer({ terms: proTerms("price_v2") });
    const historical = await registerHistoricalBillingOffer({
      terms: proTerms("price_v1"),
      ownershipVerified: true,
    });

    expect(offers.get(current.id).checkoutEnabled).toBe(true);
    expect(offers.get(historical.id)).toMatchObject({
      stripePriceId: "price_v1",
      checkoutEnabled: false,
    });
  });

  it("requires an explicit verified-ownership proof before learning history", async () => {
    await expect(
      registerHistoricalBillingOffer({
        terms: proTerms("price_unowned"),
        ownershipVerified: false as true,
      }),
    ).rejects.toThrow("ownership must be verified");
    expect(offers.size).toBe(0);
  });
});
