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
  getSubscription: vi.fn(),
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
  getSubscription: mocks.getSubscription,
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
      recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
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

describe("billing page granted plans", () => {
  const balance = {
    monthlyUsage: { usedPercent: 0, remainingPercent: 100, isExhausted: false },
    additionalCredits: 0,
    hasAdditionalCreditDebt: false,
  };
  const grantEndsAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1_000);

  // A grant in effect, as getEntitlementSubscription shapes it.
  const storageGrant = {
    source: "grant",
    status: "active",
    planId: "storage",
    tier: "1tb",
    billingOfferId: null,
    currentPeriodStart: new Date(),
    currentPeriodEnd: FUTURE,
    cancelAt: grantEndsAt,
    cancelAtPeriodEnd: false,
    entitlementHeld: false,
    grant: { id: "grant-1", endsAt: grantEndsAt },
  };

  function stripeRow(planId: string, overrides: Record<string, unknown> = {}) {
    return {
      status: "past_due",
      planId,
      tier: planId === "storage" ? "100gb" : null,
      billingOfferId: `offer_${planId}`,
      currentPeriodEnd: FUTURE,
      cancelAt: null,
      cancelAtPeriodEnd: false,
      entitlementHeld: false,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockResolvedValue({});
    mocks.getEntitlementSummary.mockResolvedValue({
      canUseAi: false,
      subscriptionStatus: null,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: null,
      grant: null,
      balance,
    });
    mocks.findCustomerByUserId.mockResolvedValue(null);
    mocks.findPackagesForBillingHistory.mockResolvedValue(new Map());
    mocks.getCreditPurchasesByUserId.mockResolvedValue([]);
    mocks.getUserPaymentHistory.mockResolvedValue([]);
    mocks.findBillingOfferByStripePriceId.mockResolvedValue(null);
    mocks.pricesRetrieve.mockRejectedValue(new Error("Stripe unreachable"));
    mocks.getSubscription.mockResolvedValue(null);
    mocks.resolveStorageQuota.mockResolvedValue({
      tier: null,
      quotaBytes: GIB,
      fileCountLimit: 10_000,
      subscription: null,
    });
  });

  it("shows a granted storage tier without offering a subscription", async () => {
    mocks.resolveStorageQuota.mockResolvedValue({
      tier: "1tb",
      quotaBytes: 1024 * GIB,
      fileCountLimit: 100_000,
      subscription: storageGrant,
    });

    const page = await retrieveBillingPage("user-1");

    expect(page.subscriptions).toEqual([
      {
        product: "storage",
        tier: "1tb",
        status: "granted",
        currentPeriodEnd: grantEndsAt.toISOString(),
        showCancellationNotice: false,
      },
    ]);
    expect(page.offers).toEqual([{ product: "aiPro" }]);
  });

  it("keeps a failed Stripe payment manageable behind a storage grant", async () => {
    mocks.resolveStorageQuota.mockResolvedValue({
      tier: "1tb",
      quotaBytes: 1024 * GIB,
      fileCountLimit: 100_000,
      subscription: storageGrant,
    });
    mocks.getSubscription.mockResolvedValue(stripeRow("storage"));

    const page = await retrieveBillingPage("user-1");

    expect(mocks.getSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ planId: "storage" }),
    );
    expect(page.subscriptions).toEqual([
      expect.objectContaining({ product: "storage", tier: "100gb", status: "needsAttention" }),
    ]);
    // The quota still comes from the grant.
    expect(page.storageQuota).toEqual({ tier: "1tb", quotaBytes: 1024 * GIB });
  });

  it("keeps a failed Stripe payment manageable behind an AI Pro grant", async () => {
    mocks.getEntitlementSummary.mockResolvedValue({
      canUseAi: true,
      subscriptionStatus: "active",
      cancelAtPeriodEnd: false,
      currentPeriodEnd: FUTURE.toISOString(),
      grant: { endsAt: null },
      balance,
    });
    mocks.getSubscription.mockResolvedValue(stripeRow("pro"));

    const page = await retrieveBillingPage("user-1");

    expect(page.subscriptions).toEqual([
      expect.objectContaining({ product: "aiPro", status: "needsAttention" }),
    ]);
    expect(page.offers).not.toContainEqual({ product: "aiPro" });
  });

  it("shows the AI Pro grant once the Stripe subscription behind it has ended", async () => {
    mocks.getEntitlementSummary.mockResolvedValue({
      canUseAi: true,
      subscriptionStatus: "active",
      cancelAtPeriodEnd: false,
      currentPeriodEnd: FUTURE.toISOString(),
      grant: { endsAt: null },
      balance,
    });
    mocks.getSubscription.mockResolvedValue(stripeRow("pro", { status: "canceled" }));

    const page = await retrieveBillingPage("user-1");

    expect(page.subscriptions).toEqual([
      {
        product: "aiPro",
        tier: null,
        status: "granted",
        currentPeriodEnd: null,
        showCancellationNotice: false,
      },
    ]);
  });

  it("does not read the Stripe rows again without a grant", async () => {
    await retrieveBillingPage("user-1");
    expect(mocks.getSubscription).not.toHaveBeenCalled();
  });
});
