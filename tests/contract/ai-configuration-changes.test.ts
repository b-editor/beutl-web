import { describe, expect, it } from "vitest";
import {
  AI_DEFAULT_OPERATION_MODELS,
  AI_PLAN_MONTHLY_USAGE_LIMIT_KEY,
  AI_SETTINGS,
  aiMinimumChargeOf,
} from "@beutl/core";
import {
  MAX_MODELS_PER_OPERATION,
  validateAiConfigurationChanges,
} from "../../apps/admin/src/lib/ai-configuration-changes";

const builtInOf = (operation: string) => [
  {
    priceUnits: (AI_DEFAULT_OPERATION_MODELS as Record<string, { price: number }>)[
      operation
    ]!.price,
    enabled: true,
  },
];

function validate(
  input: unknown,
  overrides: {
    storedModelsOf?: (
      operation: string,
    ) => { priceUnits: number; enabled: boolean }[];
    currentSettingValueOf?: (key: string) => string;
  } = {},
) {
  return validateAiConfigurationChanges(input, {
    currentSettingValueOf:
      overrides.currentSettingValueOf ??
      ((key) => AI_SETTINGS[key]?.fallback ?? ""),
    storedModelsOf: overrides.storedModelsOf ?? builtInOf,
    builtInModelsOf: builtInOf,
    minimumChargeOf: (operation, priceUnits) =>
      aiMinimumChargeOf(operation, priceUnits) ?? priceUnits,
  });
}

function model(overrides: Record<string, unknown> = {}) {
  return {
    modelId: "openai/gpt-image-1",
    priceUnits: 20,
    displayName: null,
    enabled: true,
    ...overrides,
  };
}

describe("saving the AI configuration in one go", () => {
  it("accepts an allowance and a model list together", () => {
    const result = validate({
      settings: [{ key: AI_PLAN_MONTHLY_USAGE_LIMIT_KEY, value: "800" }],
      models: [
        {
          operation: "image.generate",
          models: [model({ displayName: "  Fast  " }), model({
            modelId: "bytedance-seed/seedream-4.5",
            priceUnits: 8,
          })],
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.allowance).toBe(800);
    expect(result.models[0]!.models.map((entry) => entry.modelId)).toEqual([
      "openai/gpt-image-1",
      "bytedance-seed/seedream-4.5",
    ]);
    expect(result.models[0]!.models[0]!.displayName).toBe("Fast");
  });

  it("measures the allowance against the prices landing with it", () => {
    // Raising a price and the allowance that covers it in one save has to be
    // judged on the state it produces; either half alone reads as a mistake.
    const result = validate({
      settings: [{ key: AI_PLAN_MONTHLY_USAGE_LIMIT_KEY, value: "900" }],
      models: [
        {
          operation: "video.generate",
          models: [model({ modelId: "google/veo-3.1", priceUnits: 200 })],
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("refuses an allowance no model of an operation could be started on", () => {
    const result = validate({
      settings: [{ key: AI_PLAN_MONTHLY_USAGE_LIMIT_KEY, value: "100" }],
      models: [
        {
          operation: "video.generate",
          models: [model({ modelId: "google/veo-3.1", priceUnits: 200 })],
        },
      ],
    });

    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.message).toContain("video.generate");
  });

  it("judges an operation it does not touch on what is stored", () => {
    const result = validate(
      { settings: [{ key: AI_PLAN_MONTHLY_USAGE_LIMIT_KEY, value: "100" }], models: [] },
      {
        storedModelsOf: (operation) =>
          operation === "video.generate"
            ? [{ priceUnits: 200, enabled: true }]
            : builtInOf(operation),
      },
    );

    expect(result).toMatchObject({ ok: false });
  });

  it("falls back to the built-in model when every row is removed", () => {
    // The stored rows are the ones going away, so they cannot answer what the
    // operation would then run on.
    const result = validate(
      {
        settings: [{ key: AI_PLAN_MONTHLY_USAGE_LIMIT_KEY, value: "100" }],
        models: [{ operation: "video.generate", models: [] }],
      },
      {
        storedModelsOf: (operation) =>
          operation === "video.generate"
            ? [{ priceUnits: 1, enabled: true }]
            : builtInOf(operation),
      },
    );

    // The built-in video model is 40 units a second, so the minimum one-second
    // request remains affordable within the 100 unit allowance.
    expect(result).toMatchObject({ ok: true });
  });

  it("ignores models nobody can pick when judging the allowance", () => {
    const result = validate({
      settings: [{ key: AI_PLAN_MONTHLY_USAGE_LIMIT_KEY, value: "100" }],
      models: [
        {
          operation: "image.generate",
          models: [
            model({ modelId: "cheap/model", priceUnits: 5, enabled: false }),
            model({ modelId: "dear/model", priceUnits: 400 }),
          ],
        },
      ],
    });

    expect(result).toMatchObject({ ok: false });
  });

  it("refuses the same model twice in one operation", () => {
    const result = validate({
      settings: [],
      models: [
        {
          operation: "image.generate",
          models: [model(), model({ priceUnits: 30 })],
        },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      message: "Duplicate model for image.generate: openai/gpt-image-1",
    });
  });

  it("refuses the same operation twice", () => {
    const result = validate({
      settings: [],
      models: [
        { operation: "image.generate", models: [model()] },
        { operation: "image.generate", models: [] },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      message: "Duplicate operation: image.generate",
    });
  });

  it("refuses an operation that does not exist", () => {
    expect(
      validate({
        settings: [],
        models: [{ operation: "image.retired", models: [model()] }],
      }),
    ).toMatchObject({ ok: false, message: "Invalid operation" });
  });

  it("caps how many models one operation can carry", () => {
    const result = validate({
      settings: [],
      models: [
        {
          operation: "image.generate",
          models: Array.from({ length: MAX_MODELS_PER_OPERATION + 1 }, (_, i) =>
            model({ modelId: `provider/model-${i}` }),
          ),
        },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      message: "Too many models for image.generate",
    });
  });

  it("refuses a save that carries nothing", () => {
    expect(validate({ settings: [], models: [] })).toMatchObject({
      ok: false,
      message: "No changes were submitted",
    });
  });

  it("refuses values whose types were lost in transit", () => {
    expect(validate(null)).toMatchObject({ ok: false });
    expect(validate({ settings: [], models: "nope" })).toMatchObject({
      ok: false,
      message: "Invalid model changes",
    });
    expect(
      validate({
        settings: [],
        models: [{ operation: "image.generate", models: [model({ enabled: "true" })] }],
      }),
    ).toMatchObject({ ok: false });
  });
});
