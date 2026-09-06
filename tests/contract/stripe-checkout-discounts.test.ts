import { describe, expect, it } from "vitest";
import {
  allowsStripePromotionCodes,
  isValidStripeCheckoutAmount,
  isValidStripeCheckoutSessionAmount,
  isZeroCostStripeCheckoutSessionAmount,
} from "@beutl/core";

describe("Stripe Checkout promotion-code amounts", () => {
  it("reads the durable Checkout parameter without trusting malformed JSON", () => {
    expect(allowsStripePromotionCodes({ allow_promotion_codes: true })).toBe(true);
    expect(allowsStripePromotionCodes('{"allow_promotion_codes":true}')).toBe(true);
    expect(allowsStripePromotionCodes({ allow_promotion_codes: false })).toBe(false);
    expect(allowsStripePromotionCodes("not-json")).toBe(false);
  });

  it("accepts a positive discount only when promotion codes were enabled", () => {
    expect(isValidStripeCheckoutAmount(1_000, 1_000, false)).toBe(true);
    expect(isValidStripeCheckoutAmount(800, 1_000, true)).toBe(true);
    expect(isValidStripeCheckoutAmount(800, 1_000, false)).toBe(false);
    expect(isValidStripeCheckoutAmount(0, 1_000, true)).toBe(false);
    expect(isValidStripeCheckoutAmount(1_001, 1_000, true)).toBe(false);
  });

  it("requires the original subtotal to validate a discounted Session", () => {
    expect(isValidStripeCheckoutSessionAmount(
      { amountSubtotal: 1_000, amountTotal: 800 },
      1_000,
      true,
    )).toBe(true);
    expect(isValidStripeCheckoutSessionAmount(
      { amountSubtotal: undefined, amountTotal: 800 },
      1_000,
      true,
    )).toBe(false);
    expect(isValidStripeCheckoutSessionAmount(
      { amountSubtotal: undefined, amountTotal: 1_000 },
      1_000,
      false,
    )).toBe(true);
    expect(isValidStripeCheckoutSessionAmount(
      { amountSubtotal: null, amountTotal: null },
      1_000,
      false,
      true,
    )).toBe(true);
  });

  it("recognizes only promotion-enabled zero-cost Sessions", () => {
    const amounts = { amountSubtotal: 1_000, amountTotal: 0 };

    expect(isZeroCostStripeCheckoutSessionAmount(amounts, 1_000, true))
      .toBe(true);
    expect(isZeroCostStripeCheckoutSessionAmount(amounts, 1_000, false))
      .toBe(false);
    expect(isZeroCostStripeCheckoutSessionAmount(
      { amountSubtotal: undefined, amountTotal: 0 },
      1_000,
      true,
    )).toBe(false);
  });
});
