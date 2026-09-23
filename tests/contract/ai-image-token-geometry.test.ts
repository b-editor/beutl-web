import { describe, expect, it } from "vitest";
import { estimateImageCost } from "../../packages/api/src/ai/cost-estimate";

describe("image output-token geometry assumptions", () => {
  it.each([
    ["legacy", "1:1", 1056],
    ["legacy", "3:2", 1568],
    ["legacy", "2:3", 1584],
    ["legacy", undefined, 1584],
    ["legacy", "16:9", 1584],
    ["grid_48_medium", "1:1", 1756],
    ["grid_48_medium", "3:2", 1372],
    ["grid_48_medium", "2:3", 1372],
    ["grid_48_medium", "16:9", 1413],
    ["grid_48_medium", "9:16", 1413],
    ["grid_48_medium", "4:3", 1507],
    ["grid_48_medium", "3:4", 1507],
    ["grid_48_medium", undefined, 1756],
  ] as const)("uses %s / %s output geometry (%s tokens)", (outputTokenProfile, aspectRatio, tokens) => {
    const estimate = estimateImageCost({
      outputTokenProfile, aspectRatio, referenceImages: 0,
      endpoints: [[{ billable: "output_image", unit: "token", costUsd: 0.00004 }]],
    });
    expect(estimate).toMatchObject({ status: "estimated", assumptions: [{ kind: "imageOutputTokens", value: tokens }] });
    if (estimate.status !== "estimated") throw new Error("Expected a token estimate");
    expect(estimate.usdMin).toBeCloseTo(tokens * 0.00004, 12);
    expect(estimate.usdMax).toBe(estimate.usdMin);
  });

  it("does not change reference-image tokens to the output shape", () => {
    expect(estimateImageCost({
      outputTokenProfile: "legacy", aspectRatio: "2:3", referenceImages: 1,
      endpoints: [[
        { billable: "output_image", unit: "token", costUsd: 0.00004 },
        { billable: "input_image", unit: "token", costUsd: 0.00001 },
      ]],
    })).toEqual({
      status: "estimated", usdMin: 0.07392, usdMax: 0.07392,
      assumptions: [{ kind: "imageOutputTokens", value: 1584 }, { kind: "imageInputTokens", value: 1056 }],
    });
  });

  it("keeps flat per-image prices independent of token geometry", () => {
    expect(estimateImageCost({
      outputTokenProfile: "grid_48_medium", aspectRatio: "2:3", referenceImages: 0,
      endpoints: [[{ billable: "output_image", unit: "image", costUsd: 0.04 }]],
    })).toEqual({ status: "estimated", usdMin: 0.04, usdMax: 0.04, assumptions: [] });
  });
});
