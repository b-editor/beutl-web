import { beforeEach, describe, expect, it } from "vitest";
import {
  AI_SETTINGS,
  aiModelSettingKey,
  AI_OPERATIONS,
} from "@beutl/core";
import { clearAiModelPricingCache, loadAiCostEstimates } from "@beutl/api";

// Hits OpenRouter's public price endpoints for real, so it is opt-in:
//
//   TEST_OPENROUTER_PRICING=1 pnpm vitest run tests/integration/ai-cost-estimate-live.test.ts
//
// The assertions stay loose on purpose. Provider prices move, and this exists
// to catch the response *shape* changing under us, not to pin a number.
const describeLive = process.env.TEST_OPENROUTER_PRICING
  ? describe
  : describe.skip;

describeLive("AI cost estimates against the live price list", () => {
  beforeEach(() => {
    clearAiModelPricingCache();
  });

  it("estimates the built-in models from real responses", async () => {
    const { entries } = await loadAiCostEstimates({
      modelsOf: (operation) => [
        AI_SETTINGS[aiModelSettingKey(operation)].fallback,
      ],
    });

    expect(entries).toHaveLength(AI_OPERATIONS.length);

    // Every built-in model should be priceable. A failure here names the
    // operation whose endpoint changed shape.
    const unknown = entries
      .filter((entry) => entry.estimate.status !== "estimated")
      .map((entry) =>
        entry.estimate.status === "unknown"
          ? `${entry.operation} (${entry.model}): ${entry.estimate.reason}`
          : entry.operation,
      );
    expect(unknown).toEqual([]);

    for (const entry of entries) {
      if (entry.estimate.status !== "estimated") continue;
      expect(entry.estimate.usdMin).toBeGreaterThan(0);
      expect(entry.estimate.usdMax).toBeLessThan(100);
    }
  });
});
