import { describe, expect, it } from "vitest";
import { AI_PLAN_MONTHLY_USAGE_LIMIT_KEY, AI_SETTINGS } from "@beutl/core";
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
  it("normalizes what it accepts and reports the allowance in force", () => {
    const result = validate([
      { key: AI_PLAN_MONTHLY_USAGE_LIMIT_KEY, value: " 900 " },
    ]);

    expect(result).toEqual({
      ok: true,
      changes: [{ key: AI_PLAN_MONTHLY_USAGE_LIMIT_KEY, value: "900" }],
      // What the caller checks the registered models against; the prices are
      // rows rather than settings, so this module cannot do it itself.
      allowance: 900,
    });
  });

  it("reports the built-in allowance when the batch resets it", () => {
    const result = validate([
      { key: AI_PLAN_MONTHLY_USAGE_LIMIT_KEY, value: null },
    ]);

    expect(result).toEqual({
      ok: true,
      changes: [{ key: AI_PLAN_MONTHLY_USAGE_LIMIT_KEY, value: null }],
      allowance: Number(AI_SETTINGS[AI_PLAN_MONTHLY_USAGE_LIMIT_KEY]!.fallback),
    });
  });

  it("reports the stored allowance when the batch does not touch it", () => {
    const result = validate(
      [{ key: AI_PLAN_MONTHLY_USAGE_LIMIT_KEY, value: "700" }],
      () => "1200",
    );

    expect(result.ok && result.allowance).toBe(700);
  });

  it("rejects a value that is not a whole allowance", () => {
    const result = validate([
      { key: AI_PLAN_MONTHLY_USAGE_LIMIT_KEY, value: "0" },
    ]);

    expect(result).toEqual({
      ok: false,
      message: `Invalid value for ${AI_PLAN_MONTHLY_USAGE_LIMIT_KEY}: limitOutOfRange`,
    });
  });

  it("rejects a key that is not a setting", () => {
    // These were settings until models moved to their own table.
    for (const key of ["price.image.generate", "model.video.generate", "nope"]) {
      expect(validate([{ key, value: "1" }])).toEqual({
        ok: false,
        message: "Invalid setting key",
      });
    }
  });

  it("rejects the same key twice, which would make the outcome order-dependent", () => {
    const result = validate([
      { key: AI_PLAN_MONTHLY_USAGE_LIMIT_KEY, value: "700" },
      { key: AI_PLAN_MONTHLY_USAGE_LIMIT_KEY, value: "900" },
    ]);

    expect(result).toEqual({
      ok: false,
      message: `Duplicate setting key: ${AI_PLAN_MONTHLY_USAGE_LIMIT_KEY}`,
    });
  });

  it("caps how much one save can touch", () => {
    const result = validate(
      Array.from({ length: MAX_CHANGES_PER_SAVE + 1 }, () => ({
        key: AI_PLAN_MONTHLY_USAGE_LIMIT_KEY,
        value: "500",
      })),
    );

    expect(result).toEqual({
      ok: false,
      message: "Too many changes were submitted",
    });
  });

  it("accepts an empty list, which is a save that only touched models", () => {
    expect(validate([])).toEqual({
      ok: true,
      changes: [],
      // The allowance still has to be reported: the models landing with it are
      // measured against it.
      allowance: Number(AI_SETTINGS[AI_PLAN_MONTHLY_USAGE_LIMIT_KEY]!.fallback),
    });
  });

  it("refuses something that is not a list", () => {
    expect(validate("nope")).toEqual({
      ok: false,
      message: "Invalid setting changes",
    });
  });
});
