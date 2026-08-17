import { describe, expect, it } from "vitest";
import {
  MAX_CHANGES_PER_SAVE,
  validateAiSettingChanges,
} from "../../apps/admin/src/lib/ai-setting-changes";

describe("AI setting change batches", () => {
  it("accepts edits and resets together", () => {
    const result = validateAiSettingChanges([
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
    const result = validateAiSettingChanges([
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
      validateAiSettingChanges([{ key: "price.unknown", value: "25" }]).ok,
    ).toBe(false);
    expect(
      validateAiSettingChanges([{ key: "__proto__", value: "25" }]).ok,
    ).toBe(false);
  });

  it("rejects the same key twice, which would make the outcome order-dependent", () => {
    const result = validateAiSettingChanges([
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
    expect(validateAiSettingChanges(input).ok).toBe(false);
  });

  it("caps how much one save can touch", () => {
    const oversized = Array.from(
      { length: MAX_CHANGES_PER_SAVE + 1 },
      (_unused, index) => ({
        key: `price.image.generate.${index}`,
        value: "25",
      }),
    );
    const result = validateAiSettingChanges(oversized);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Too many");
    }
  });
});
