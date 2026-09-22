import { describe, expect, it } from "vitest";
import { usageUnitsForProviderCost } from "@beutl/core";
import {
  gatewayProviderCostUsd,
  providerCostUsd,
  withProviderCost,
} from "../../packages/api/src/ai/provider-cost";
import { providerCostUsdToMicros } from "../../packages/api/src/ai/usage-cost";

describe("exact provider-reported costs", () => {
  it.each([0, 0.04, Number.MIN_VALUE])("retains a numeric cost of %s", (cost) => {
    expect(providerCostUsd(cost)).toBe(cost);
  });

  it.each(["0", "-0.000", "0.0400", "0.0034567800000000000001", "3.4567800000000000001E-3", "+.5", "1e-400"])(
    "preserves every digit of decimal string %s",
    (cost) => expect(providerCostUsd(` ${cost} `)).toBe(cost),
  );

  const invalidCosts = [
    undefined, null, true, {}, [], NaN, Infinity, -0.01,
    "", " ", "NaN", "Infinity", "-0.01", "-1e-400", "0x10", "0b10", "1/2", "1.2.3",
    "1e1000000000", "1e-1000000000", "0." + "0".repeat(1024) + "1",
  ];
  it.each(invalidCosts.map((cost) => ({ cost })))("rejects malformed or excessive input %#", ({ cost }) => {
    expect(providerCostUsd(cost)).toBeUndefined();
    expect(usageUnitsForProviderCost(cost as never, 0.01, 150)).toBeNull();
    expect(providerCostUsdToMicros(cost as never)).toBeNull();
  });

  it.each([
    ["0.00345678", 0.518517],
    ["0.0034567800000000000001", 0.518518],
    ["3.4567800000000000001E-3", 0.518518],
    ["1e-400", 0.000001],
    ["0.0000", 0],
    ["-0.000", 0],
  ] as const)("rounds $%s to %s units after applying 150 percent", (cost, expected) => {
    const reported = gatewayProviderCostUsd({ gateway: { cost } });
    expect(reported).toBeDefined();
    expect(usageUnitsForProviderCost(reported!, 0.01, 150)).toBe(expected);
  });

  it.each([
    [0.04, 40_000],
    ["0.04", 40_000],
    ["0.000001", 1],
    ["0.0000010000000000000001", 2],
    ["1e-400", 1],
    ["0", 0],
    ["2147.483647", 2_147_483_647],
    ["2147.4836470000000000001", null],
  ] as const)("rounds the audit amount $%s separately to USD micros", (cost, expected) => {
    expect(providerCostUsdToMicros(cost)).toBe(expected);
  });

  it("keeps exact translation cost metadata out of the serialized result", () => {
    const cost = providerCostUsd("0.0034567800000000000001");
    const result = withProviderCost([{ id: 1, text: "Hello" }], cost);
    expect(result.providerCostUsd).toBe("0.0034567800000000000001");
    expect(JSON.stringify(result)).toBe('[{"id":1,"text":"Hello"}]');
  });
});
