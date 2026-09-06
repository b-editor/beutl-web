import { describe, expect, it } from "vitest";
import {
  isStripeResourceMissing,
  selectPackagePaymentAmount,
} from "../../apps/web/scripts/backfill-package-payment-amounts.mjs";

describe("package payment amount backfill", () => {
  it("takes the authorized amount so backfilled rows match webhook-written ones", () => {
    expect(
      selectPackagePaymentAmount({
        amount: 1_000,
        amount_received: 400,
        currency: "usd",
      }),
    ).toEqual({ amount: 1_000, currency: "usd" });
  });

  it("lower-cases the currency", () => {
    expect(
      selectPackagePaymentAmount({ amount: 1_000, currency: "USD" }),
    ).toEqual({ amount: 1_000, currency: "usd" });
  });

  it("refuses an amount that cannot be a real charge", () => {
    expect(selectPackagePaymentAmount({ amount: 0, currency: "usd" })).toBeNull();
    expect(
      selectPackagePaymentAmount({ amount: -100, currency: "usd" }),
    ).toBeNull();
    expect(
      selectPackagePaymentAmount({ amount: 10.5, currency: "usd" }),
    ).toBeNull();
  });

  it("refuses a missing or blank currency", () => {
    expect(selectPackagePaymentAmount({ amount: 1_000 })).toBeNull();
    expect(
      selectPackagePaymentAmount({ amount: 1_000, currency: "  " }),
    ).toBeNull();
  });

  it("recognises a deleted PaymentIntent so the backfill can skip it", () => {
    expect(isStripeResourceMissing({ code: "resource_missing" })).toBe(true);
    expect(isStripeResourceMissing({ code: "rate_limit" })).toBe(false);
    expect(isStripeResourceMissing(new Error("network"))).toBe(false);
    expect(isStripeResourceMissing(null)).toBe(false);
  });
});
