import { describe, expect, it } from "vitest";
import { AI_SETTINGS } from "@beutl/core";
import {
  MAX_CHANGES_PER_SAVE,
  validateAiSettingChanges,
} from "../../apps/admin/src/lib/ai-setting-changes";

// Nothing stored: every setting the batch leaves alone is on its built-in
// default, which is the state a fresh deployment saves from.
function storedDefaultOf(key: string): string {
  return AI_SETTINGS[key]?.fallback ?? "";
}

function validate(input: unknown, stored = storedDefaultOf) {
  return validateAiSettingChanges(input, stored);
}

describe("AI setting change batches", () => {
  it("accepts edits and resets together", () => {
    const result = validate([
      { key: "price.image.generate", value: " 25 " },
      { key: "model.video.generate", value: "google/veo-3.1" },
      { key: "plan.monthlyUsageLimit", value: null },
    ]);

    expect(result).toEqual({
      ok: true,
      changes: [
        // Values are normalized on the way in, exactly as a single save did.
        { key: "price.image.generate", value: "25" },
        { key: "model.video.generate", value: "google/veo-3.1" },
        { key: "plan.monthlyUsageLimit", value: null },
      ],
    });
  });

  it("rejects the whole batch when one value is invalid", () => {
    const result = validate([
      { key: "price.image.generate", value: "25" },
      { key: "price.video.generate", value: "0" },
    ]);

    // Saving the valid half would price one operation on the new rate and
    // leave the other on the old one.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("price.video.generate");
    }
  });

  it("rejects a key that is not a setting", () => {
    expect(
      validate([{ key: "price.unknown", value: "25" }]).ok,
    ).toBe(false);
    expect(
      validate([{ key: "__proto__", value: "25" }]).ok,
    ).toBe(false);
  });

  it("rejects the same key twice, which would make the outcome order-dependent", () => {
    const result = validate([
      { key: "price.image.generate", value: "25" },
      { key: "price.image.generate", value: "30" },
    ]);
    expect(result.ok).toBe(false);
  });

  it.each([
    ["nothing", []],
    ["a non-array", "price.image.generate=25"],
    ["a non-object entry", ["price.image.generate"]],
    ["a value that is not a string", [{ key: "price.image.generate", value: 25 }]],
  ])("rejects %s", (_label, input) => {
    expect(validate(input).ok).toBe(false);
  });

  it("rejects an allowance that would put a stored price out of reach", () => {
    // A digit short on the allowance passes its own range check and takes every
    // operation offline: nothing priced above 5 units can be started.
    const result = validate([{ key: "plan.monthlyUsageLimit", value: "5" }]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("price.");
      expect(result.message).toContain("5 unit monthly allowance");
    }
  });

  it("rejects a price raised above the allowance being saved with it", () => {
    const result = validate([
      { key: "plan.monthlyUsageLimit", value: "100" },
      { key: "price.video.generate", value: "101" },
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("price.video.generate");
    }
  });

  it("accepts a price the allowance raised in the same batch makes room for", () => {
    // The pair used to be checked against a fixed ceiling, so a costlier model
    // needed a redeploy however large the allowance was.
    const result = validate([
      { key: "plan.monthlyUsageLimit", value: "5000" },
      { key: "price.video.generate", value: "800" },
    ]);

    expect(result.ok).toBe(true);
  });

  it("caps how much one save can touch", () => {
    const oversized = Array.from(
      { length: MAX_CHANGES_PER_SAVE + 1 },
      (_unused, index) => ({
        key: `price.image.generate.${index}`,
        value: "25",
      }),
    );
    const result = validate(oversized);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Too many");
    }
  });
});
