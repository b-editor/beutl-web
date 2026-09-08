import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEntitlementSummary: vi.fn(),
  getDb: vi.fn(),
  pricesRetrieve: vi.fn(),
  findCustomerByUserId: vi.fn(),
  findPackagesForBillingHistory: vi.fn(),
  getCreditPurchasesByUserId: vi.fn(),
  getUserPaymentHistory: vi.fn(),
  resolveStorageQuota: vi.fn(),
  findBillingOfferByStripePriceId: vi.fn(),
}));

vi.mock("@beutl/api/ai/entitlements", () => ({ getEntitlementSummary: mocks.getEntitlementSummary }));
vi.mock("@beutl/db", () => ({
  getDb: mocks.getDb,
  findCustomerByUserId: mocks.findCustomerByUserId,
  findPackagesForBillingHistory: mocks.findPackagesForBillingHistory,
  getCreditPurchasesByUserId: mocks.getCreditPurchasesByUserId,
  getUserPaymentHistory: mocks.getUserPaymentHistory,
  resolveStorageQuota: mocks.resolveStorageQuota,
  findBillingOfferByStripePriceId: mocks.findBillingOfferByStripePriceId,
}));
vi.mock("@/lib/stripe/config", () => ({
  createStripe: () => ({ prices: { retrieve: mocks.pricesRetrieve } }),
}));
vi.mock("@/lib/stripe/billing-documents", () => ({
  retrieveBillingDocuments: vi.fn().mockResolvedValue({
    subscriptionPayments: [],
    documentByPaymentIntentId: new Map(),
  }),
}));

import { retrieveBillingPage } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/account/billing/queries";

const GIB = 1024 * 1024 * 1024;
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000);

describe("billing page storage plan entries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockResolvedValue({});
    mocks.getEntitlementSummary.mockResolvedValue({
      canUseAi: false,
      subscriptionStatus: null,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: null,
      balance: {
        monthlyUsage: { usedPercent: 0, remainingPercent: 100, isExhausted: false },
        additionalCredits: 0,
        hasAdditionalCreditDebt: false,
      },
    });
    mocks.findCustomerByUserId.mockResolvedValue(null);
    mocks.findPackagesForBillingHistory.mockResolvedValue(new Map());
    mocks.getCreditPurchasesByUserId.mockResolvedValue([]);
    mocks.getUserPaymentHistory.mockResolvedValue([]);
    process.env.STRIPE_STORAGE_PRICE_ID_100GB = "price_100";
    process.env.STRIPE_STORAGE_PRICE_ID_200GB = "price_200";
    process.env.STRIPE_STORAGE_PRICE_ID_1TB = "price_1tb";
    mocks.findBillingOfferByStripePriceId.mockResolvedValue(null);
    mocks.pricesRetrieve.mockRejectedValue(new Error("Stripe unreachable"));
  });

  it("offers every tier to an account without a storage subscription", async () => {
    mocks.resolveStorageQuota.mockResolvedValue({
      tier: null,
      quotaBytes: GIB,
      fileCountLimit: 10_000,
      subscription: null,
    });

    const page = await retrieveBillingPage("user-1");

    expect(page.subscriptions).toEqual([]);
    expect(page.offers).toEqual([
      { product: "aiPro" },
      { product: "storage", tiers: ["100gb", "200gb", "1tb"] },
    ]);
    expect(page.storageQuota).toEqual({ tier: null, quotaBytes: GIB });
  });

  it("lists an active storage subscription with its tier and next billing date", async () => {
    mocks.resolveStorageQuota.mockResolvedValue({
      tier: "200gb",
      quotaBytes: 200 * GIB,
      fileCountLimit: 100_000,
      subscription: {
        status: "active",
        tier: "200gb",
        cancelAtPeriodEnd: false,
        cancelAt: null,
        currentPeriodEnd: FUTURE,
      },
    });

    const page = await retrieveBillingPage("user-1");

    expect(page.subscriptions).toEqual([
      {
        product: "storage",
        tier: "200gb",
        status: "active",
        currentPeriodEnd: FUTURE.toISOString(),
        showCancellationNotice: false,
      },
    ]);
    expect(page.offers).toEqual([{ product: "aiPro" }]);
  });

  it("shows a scheduled cancellation with the cancel date as the end", async () => {
    const cancelAt = new Date(FUTURE.getTime() - 60_000);
    mocks.resolveStorageQuota.mockResolvedValue({
      tier: "100gb",
      quotaBytes: 100 * GIB,
      fileCountLimit: 100_000,
      subscription: {
        status: "active",
        tier: "100gb",
        cancelAtPeriodEnd: true,
        cancelAt,
        currentPeriodEnd: FUTURE,
      },
    });

    const page = await retrieveBillingPage("user-1");

    expect(page.subscriptions[0]).toMatchObject({
      product: "storage",
      status: "cancelScheduled",
      currentPeriodEnd: cancelAt.toISOString(),
      showCancellationNotice: true,
    });
  });

  it("keeps the subscribed tier on a subscription that grants nothing right now", async () => {
    // past_due: the row still names its tier, the quota has fallen back to
    // free, and the customer is asked to sort the payment out.
    mocks.resolveStorageQuota.mockResolvedValue({
      tier: null,
      quotaBytes: GIB,
      fileCountLimit: 10_000,
      subscription: {
        status: "past_due",
        tier: "200gb",
        cancelAtPeriodEnd: false,
        cancelAt: null,
        currentPeriodEnd: FUTURE,
      },
    });

    const page = await retrieveBillingPage("user-1");

    expect(page.subscriptions).toEqual([
      expect.objectContaining({ product: "storage", tier: "200gb", status: "needsAttention" }),
    ]);
    expect(page.storageQuota).toEqual({ tier: null, quotaBytes: GIB });
  });

  it("offers the plan again once a subscription has lapsed", async () => {
    mocks.resolveStorageQuota.mockResolvedValue({
      tier: null,
      quotaBytes: GIB,
      fileCountLimit: 10_000,
      subscription: { status: "canceled", cancelAtPeriodEnd: false, cancelAt: null, currentPeriodEnd: new Date(0) },
    });

    const page = await retrieveBillingPage("user-1");

    expect(page.subscriptions).toEqual([]);
    expect(page.offers).toContainEqual({ product: "storage", tiers: ["100gb", "200gb", "1tb"] });
  });

  it("describes only the tiers whose Price could be sold right now", async () => {
    mocks.resolveStorageQuota.mockResolvedValue({
      tier: null,
      quotaBytes: GIB,
      fileCountLimit: 10_000,
      subscription: null,
    });
    const price = (id: string, unitAmount: number, active: boolean) => ({
      id,
      active,
      type: "recurring",
      unit_amount: unitAmount,
      currency: "usd",
      product: `prod_${id}`,
      recurring: { interval: "month", interval_count: 1 },
    });
    mocks.pricesRetrieve.mockImplementation(async (priceId: string) => {
      if (priceId === "price_100") return price(priceId, 500, true);
      // Archived in the Stripe Dashboard: activation would refuse it, so the
      // dialog must not offer it either.
      if (priceId === "price_200") return price(priceId, 900, false);
      throw new Error("unknown price");
    });

    const page = await retrieveBillingPage("user-1");

    expect(page.storageTierPrices).toEqual({
      "100gb": { unitAmount: 500, currency: "usd" },
      "200gb": null,
      "1tb": null,
    });
  });
});
