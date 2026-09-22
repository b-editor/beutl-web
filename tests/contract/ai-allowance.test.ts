import { describe, expect, it } from "vitest";
import {
  AI_OPERATIONS,
  AI_DEFAULT_OPERATION_MODELS,
  AI_PRICING_CATALOG,
  DEFAULT_MONTHLY_USAGE_LIMIT,
  derivePlanUnitValue,
  deriveTopUpUnitValue,
  describeAllowanceEquivalent,
  describeAllowanceEquivalents,
  formatAmount,
  formatFractionalAmount,
  operationAmount,
  usageUnitsForProviderCost,
} from "@beutl/core";

const defaultPriceOf = (operation: string) =>
  (AI_DEFAULT_OPERATION_MODELS as Record<string, { price: number }>)[operation]!
    .price;

describe("AI billing catalog", () => {
  // The catalog and the built-in model table are separate objects that must
  // list the same operations. Nothing checked that until now.
  it("covers exactly the operations that have a built-in model", () => {
    expect(Object.keys(AI_PRICING_CATALOG).sort()).toEqual(
      [...AI_OPERATIONS].sort(),
    );
  });
});

describe("allowance equivalents", () => {
  it("reports what the built-in allowance buys for every operation", () => {
    const byOperation = new Map(
      describeAllowanceEquivalents({
        allowanceUnits: DEFAULT_MONTHLY_USAGE_LIMIT,
        priceOf: defaultPriceOf,
      }).map((entry) => [entry.operation, entry]),
    );

    expect(byOperation.size).toBe(AI_OPERATIONS.length);
    expect(byOperation.get("image.generate")?.quantity).toEqual({
      kind: "request",
      value: 25,
    });
    expect(byOperation.get("image.edit.remove_background")?.quantity).toEqual({
      kind: "request",
      value: 50,
    });
    // 500 / 15 = 33.3, and a partial request cannot be started.
    expect(byOperation.get("image.edit.upscale")?.quantity).toEqual({
      kind: "request",
      value: 33,
    });
    expect(byOperation.get("audio.transcribe")?.quantity).toEqual({
      kind: "minute",
      value: 100,
    });
    // Billed per started 1,000 characters, so 100 chargeable units read as
    // 100,000 characters.
    expect(byOperation.get("subtitle.translate")?.quantity).toEqual({
      kind: "character",
      value: 100_000,
    });
    // 500 / 40 = 12.5. A 13th second would cost 520 units, so the plan buys 12.
    expect(byOperation.get("video.generate")?.quantity).toEqual({
      kind: "second",
      value: 12,
    });
  });

  it("floors at the boundary instead of promising an unusable fraction", () => {
    expect(
      describeAllowanceEquivalent({
        operation: "image.generate",
        allowanceUnits: 40,
        price: 40,
      }),
    ).toMatchObject({ billingUnits: 1, affordable: true });

    expect(
      describeAllowanceEquivalent({
        operation: "video.generate",
        allowanceUnits: 79,
        price: 40,
      }),
    ).toMatchObject({ billingUnits: 1 });

    expect(
      describeAllowanceEquivalent({
        operation: "video.generate",
        allowanceUnits: 39,
        price: 40,
      }),
    ).toMatchObject({ billingUnits: 0, affordable: false });
  });

  it("calls an operation affordable only at the smallest request it accepts", () => {
    // A valid one-second clip is the smallest request the video endpoint takes.
    expect(
      describeAllowanceEquivalent({
        operation: "video.generate",
        allowanceUnits: 39,
        price: 40,
      }),
    ).toMatchObject({ billingUnits: 0, affordable: false });

    expect(
      describeAllowanceEquivalent({
        operation: "video.generate",
        allowanceUnits: 40,
        price: 40,
      }),
    ).toMatchObject({ billingUnits: 1, affordable: true });
  });

  it.each([
    ["a zero allowance", 0, 20],
    ["a negative allowance", -100, 20],
    ["a zero price", 500, 0],
    ["a negative price", 500, -20],
    ["a non-finite price", 500, Number.NaN],
    ["an infinite allowance", Number.POSITIVE_INFINITY, 20],
  ])("returns nothing usable for %s", (_label, allowanceUnits, price) => {
    const result = describeAllowanceEquivalent({
      operation: "image.generate",
      allowanceUnits,
      price,
    });

    expect(result).toMatchObject({
      billingUnits: 0,
      affordable: false,
      quantity: { value: 0 },
    });
    // Infinity and NaN must never reach a rendered figure.
    expect(Number.isFinite(result!.billingUnits)).toBe(true);
    expect(Number.isFinite(result!.quantity.value)).toBe(true);
  });

  it("rejects an operation that is not billable", () => {
    expect(
      describeAllowanceEquivalent({
        operation: "image.unknown",
        allowanceUnits: 500,
        price: 20,
      }),
    ).toBeNull();
    expect(
      describeAllowanceEquivalent({
        operation: "constructor",
        allowanceUnits: 500,
        price: 20,
      }),
    ).toBeNull();
  });
});

describe("usage unit value", () => {
  const topUpOffer = {
    unitAmount: 1000,
    currency: "jpy",
    creditAmount: 500,
  };
  const proOffer = {
    unitAmount: 1480,
    currency: "jpy",
    creditAmount: null,
  };

  it("derives the rate a top-up actually charges", () => {
    expect(deriveTopUpUnitValue(topUpOffer)).toEqual({
      minorUnitsPerUnit: 2,
      currency: "jpy",
    });
  });

  it("derives what the allowance earns per unit", () => {
    expect(derivePlanUnitValue(proOffer, 500)).toEqual({
      minorUnitsPerUnit: 2.96,
      currency: "jpy",
    });
    // Raising the allowance dilutes the plan's revenue per unit.
    expect(derivePlanUnitValue(proOffer, 1000)?.minorUnitsPerUnit).toBe(1.48);
  });

  it.each([
    ["no offer at all", null],
    ["an offer without a credit amount", { ...topUpOffer, creditAmount: null }],
    ["a zero credit amount", { ...topUpOffer, creditAmount: 0 }],
    ["a zero unit amount", { ...topUpOffer, unitAmount: 0 }],
  ])("reports no top-up rate for %s", (_label, offer) => {
    expect(deriveTopUpUnitValue(offer)).toBeNull();
  });

  it("reports no plan rate without an allowance to divide by", () => {
    expect(derivePlanUnitValue(proOffer, 0)).toBeNull();
    expect(derivePlanUnitValue(null, 500)).toBeNull();
  });

  it("prices one chargeable unit of an operation", () => {
    const value = derivePlanUnitValue(proOffer, 500);
    const amount = operationAmount(value, 20);
    expect(amount?.currency).toBe("jpy");
    expect(amount?.minorUnits).toBeCloseTo(59.2, 10);
    expect(operationAmount(value, 0)).toBeNull();
    expect(operationAmount(null, 20)).toBeNull();
  });
});

describe("actual provider cost conversion", () => {
  it.each([
    [0.04, 0.01, 100, 4],
    [0.04, 0.01, 150, 6],
    [0.04, 0.01, 50, 2],
    [0.001, 0.01, 100, 0.1],
    [0.001, 0.01, 150, 0.15],
    [0.000001, 0.01, 50, 0.00005],
    [0.00345678, 0.01, 100, 0.345678],
    [0.00345678, 0.01, 150, 0.518517],
    [0.0000005, 0.01, 100, 0.00005],
    [0.0000005, 0.01, 50, 0.000025],
    [0.01, 0.03, 100, 0.333334],
    [0.000000000001, 1000, 1, 0.000001],
    [0, 0.01, 150, 0],
  ])("converts $%s at $%s/unit and %s%% to %s units", (
    cost,
    rate,
    percent,
    expected,
  ) => {
    expect(usageUnitsForProviderCost(cost, rate, percent)).toBe(expected);
  });

  it.each([
    [Number.MAX_VALUE, 0.01, 100],
    [1, Number.MIN_VALUE, 100],
    [Number.NaN, 0.01, 100],
    [Number.POSITIVE_INFINITY, 0.01, 100],
    [-0.01, 0.01, 100],
    [0.01, 0, 100],
    [0.01, Number.NaN, 100],
    [0.01, 0.01, 1.5],
  ])("rejects invalid or out-of-range conversion (%s, %s, %s)", (cost, rate, percent) => {
    expect(usageUnitsForProviderCost(cost, rate, percent)).toBeNull();
  });
});

describe("fractional amount formatting", () => {
  it("keeps the decimals a zero-decimal currency would otherwise lose", () => {
    // formatAmount would render this as ￥3 and make a cost ratio look wrong.
    expect(formatFractionalAmount(2.96, "jpy", "en")).toBe("¥2.96");
    expect(formatFractionalAmount(2.96, "usd", "en")).toBe("$0.0296");
  });

  it("leaves the existing formatter untouched", () => {
    expect(formatAmount(1480, "jpy", "en")).toBe("¥1,480");
    expect(formatAmount(1480, "usd", "en")).toBe("$14.80");
  });
});
