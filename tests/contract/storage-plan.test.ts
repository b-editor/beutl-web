import { describe, expect, it } from "vitest";
import {
  STORAGE_FREE_FILE_COUNT_LIMIT,
  STORAGE_FREE_QUOTA_BYTES,
  STORAGE_MAX_FILE_BYTES,
  STORAGE_MULTIPART_MAX_PARTS,
  STORAGE_PAID_FILE_COUNT_LIMIT,
  STORAGE_PLAN,
  STORAGE_PLAN_TIERS,
  STORAGE_TIER_IDS,
  STORAGE_UPLOAD_PART_BYTES,
  activeSubscriptionTierOf,
  isActiveSubscription,
  isStorageTierId,
  storageQuotaFor,
  storageTierOf,
} from "@beutl/core";

const GIB = 1024 * 1024 * 1024;
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000);
const PAST = new Date(Date.now() - 60 * 1_000);

function activeRow(overrides: Record<string, unknown> = {}) {
  return {
    status: "active",
    planId: STORAGE_PLAN.id,
    tier: "200gb",
    billingOfferId: "offer_storage_200",
    currentPeriodEnd: FUTURE,
    cancelAt: null,
    entitlementHeld: false,
    ...overrides,
  };
}

describe("storage plan catalog", () => {
  it("names three ascending tiers with the agreed quotas", () => {
    expect(STORAGE_TIER_IDS).toEqual(["100gb", "200gb", "1tb"]);
    expect(STORAGE_PLAN_TIERS.map((tier) => tier.quotaBytes)).toEqual([
      100 * GIB,
      200 * GIB,
      1024 * GIB,
    ]);
    for (const tier of STORAGE_PLAN_TIERS) {
      expect(tier.fileCountLimit).toBe(STORAGE_PAID_FILE_COUNT_LIMIT);
      // Every quota must survive a Number without losing bytes.
      expect(Number.isSafeInteger(tier.quotaBytes)).toBe(true);
    }
    expect(STORAGE_PAID_FILE_COUNT_LIMIT).toBe(100_000);
  });

  it("keeps the free quota as the fallback", () => {
    expect(storageQuotaFor(null)).toEqual({
      tier: null,
      quotaBytes: STORAGE_FREE_QUOTA_BYTES,
      fileCountLimit: STORAGE_FREE_FILE_COUNT_LIMIT,
    });
    expect(STORAGE_FREE_QUOTA_BYTES).toBe(GIB);
    expect(STORAGE_FREE_FILE_COUNT_LIMIT).toBe(10_000);
    expect(storageQuotaFor("1tb")).toEqual({
      tier: "1tb",
      quotaBytes: 1024 * GIB,
      fileCountLimit: STORAGE_PAID_FILE_COUNT_LIMIT,
    });
    expect(storageTierOf("100gb").id).toBe("100gb");
    expect(() => storageTierOf("2tb" as never)).toThrow(RangeError);
  });

  it("caps a single file at the bucket's part limit", () => {
    expect(STORAGE_MULTIPART_MAX_PARTS).toBe(10_000);
    expect(STORAGE_MAX_FILE_BYTES).toBe(
      STORAGE_MULTIPART_MAX_PARTS * STORAGE_UPLOAD_PART_BYTES,
    );
    // 10,000 parts of 16 MiB: 160,000 MiB, a little over 156 GiB.
    expect(STORAGE_MAX_FILE_BYTES).toBe(10_000 * 16 * 1024 * 1024);
    expect(STORAGE_MAX_FILE_BYTES).toBeLessThan(1024 * GIB);
  });

  it("recognizes only the catalogued tier ids", () => {
    expect(isStorageTierId("100gb")).toBe(true);
    expect(isStorageTierId("1TB")).toBe(false);
    expect(isStorageTierId(null)).toBe(false);
    expect(isStorageTierId(100)).toBe(false);
  });
});

describe("storage subscription entitlement", () => {
  it("grants the tier only for an active, unheld, priced subscription", () => {
    expect(isActiveSubscription(activeRow(), "storage")).toBe(true);
    expect(activeSubscriptionTierOf(activeRow(), "storage")).toBe("200gb");
  });

  it("denies every non-entitling state", () => {
    expect(isActiveSubscription(null, "storage")).toBe(false);
    expect(isActiveSubscription(activeRow({ status: "past_due" }), "storage")).toBe(false);
    expect(isActiveSubscription(activeRow({ entitlementHeld: true }), "storage")).toBe(false);
    expect(isActiveSubscription(activeRow({ planId: "pro" }), "storage")).toBe(false);
    expect(isActiveSubscription(activeRow({ billingOfferId: null }), "storage")).toBe(false);
    expect(isActiveSubscription(activeRow({ billingOfferId: "" }), "storage")).toBe(false);
    expect(isActiveSubscription(activeRow({ currentPeriodEnd: null }), "storage")).toBe(false);
    expect(isActiveSubscription(activeRow({ currentPeriodEnd: PAST }), "storage")).toBe(false);
  });

  it("ends at cancel_at when it precedes the period end", () => {
    expect(
      isActiveSubscription(activeRow({ cancelAt: PAST }), "storage"),
    ).toBe(false);
    expect(
      isActiveSubscription(
        activeRow({ cancelAt: new Date(FUTURE.getTime() + 1) }),
        "storage",
      ),
    ).toBe(true);
  });

  it("falls back to the free quota for a tier this build does not know", () => {
    expect(activeSubscriptionTierOf(activeRow({ tier: "5tb" }), "storage")).toBeNull();
    expect(storageQuotaFor(activeSubscriptionTierOf(activeRow({ tier: "5tb" }), "storage"))).toMatchObject({
      tier: null,
      quotaBytes: STORAGE_FREE_QUOTA_BYTES,
    });
  });
});
