import { describe, expect, it } from "vitest";
import {
  aiOperationWouldGoOffline,
  validateAiOperationModelInput,
} from "../../apps/admin/src/lib/ai-operation-model-changes";
import { MAX_PRICE_UNITS } from "@beutl/core";

function input(overrides: Record<string, unknown> = {}) {
  return {
    operation: "image.generate",
    modelId: "openai/gpt-image-1",
    priceUnits: 20,
    displayName: null,
    enabled: true,
    ...overrides,
  };
}

describe("registering a model for an operation", () => {
  it("accepts a well-formed row and trims what it stores", () => {
    const result = validateAiOperationModelInput(
      input({ modelId: " openai/gpt-image-1 ", displayName: "  Fast  " }),
    );

    expect(result).toEqual({
      ok: true,
      value: {
        operation: "image.generate",
        modelId: "openai/gpt-image-1",
        // A row that names no provider belongs to the one that predates the
        // column, so every registration made before it keeps running where it ran.
        provider: "openrouter",
        priceUnits: 20,
        displayName: "Fast",
        enabled: true,
      },
    });
  });

  it("keeps a provider the row names", () => {
    const result = validateAiOperationModelInput(
      input({ provider: "vercel-gateway", operation: "video.generate" }),
    );

    expect(result.ok && result.value.provider).toBe("vercel-gateway");
  });

  it("refuses a row whose provider cannot run the operation", () => {
    // Vercel AI Gateway has no named operation for background removal. Without
    // this the row saves, and the request is refused only after the user has
    // been charged.
    const supportsOperation = (provider: string, operation: string) =>
      provider === "openrouter" || operation === "video.generate";

    const refused = validateAiOperationModelInput(
      input({
        provider: "vercel-gateway",
        operation: "image.edit.remove_background",
      }),
      { supportsOperation },
    );
    expect(refused).toEqual({
      ok: false,
      message: "vercel-gateway cannot run image.edit.remove_background",
    });

    const accepted = validateAiOperationModelInput(
      input({ provider: "vercel-gateway", operation: "video.generate" }),
      { supportsOperation },
    );
    expect(accepted.ok).toBe(true);
  });

  it("treats a blank display name as absent", () => {
    const result = validateAiOperationModelInput(input({ displayName: "   " }));

    // The catalog shows the model id when no name was given; storing a blank
    // string would show an empty label instead.
    expect(result.ok && result.value.displayName).toBeNull();
  });

  it("refuses an operation that does not exist", () => {
    expect(
      validateAiOperationModelInput(input({ operation: "image.retired" })).ok,
    ).toBe(false);
  });

  it("refuses a model id that is not provider/model", () => {
    for (const modelId of ["", "gpt-image-1", "openai/", "/gpt-image-1"]) {
      expect(validateAiOperationModelInput(input({ modelId })).ok).toBe(false);
    }
  });

  it("refuses a price that is not a whole number in range", () => {
    for (const priceUnits of [0, -1, 1.5, MAX_PRICE_UNITS + 1, "20"]) {
      expect(validateAiOperationModelInput(input({ priceUnits })).ok).toBe(
        false,
      );
    }
  });

  it("refuses values whose types were lost in transit", () => {
    expect(validateAiOperationModelInput(input({ enabled: "true" })).ok).toBe(
      false,
    );
    expect(validateAiOperationModelInput(null).ok).toBe(false);
  });

  it("takes no display order from the caller", () => {
    // Which model a request without one runs on is the lowest order, so the
    // server appends a new row and a separate action moves one to the front;
    // a number typed here would decide that indirectly.
    const result = validateAiOperationModelInput(input({ sortOrder: 5 }));

    expect(result.ok && "sortOrder" in result.value).toBe(false);
  });
});

describe("keeping an operation startable", () => {
  const minimumChargeOf = (
    _model: { modelId: string; provider: string },
    priceUnits: number,
  ) => priceUnits * 4;

  it("allows a model nobody can afford beside one they can", () => {
    // An expensive option is an offer, not a misconfiguration.
    expect(
      aiOperationWouldGoOffline({
        minimumChargeOf,
        models: [
          { modelId: "affordable", provider: "openrouter", priceUnits: 10, enabled: true },
          { modelId: "expensive", provider: "openrouter", priceUnits: 400, enabled: true },
        ],
        allowance: 500,
      }),
    ).toBe(false);
  });

  it("refuses to leave every enabled model above the allowance", () => {
    expect(
      aiOperationWouldGoOffline({
        minimumChargeOf,
        models: [
          { modelId: "expensive", provider: "openrouter", priceUnits: 200, enabled: true },
          { modelId: "dearer", provider: "openrouter", priceUnits: 400, enabled: true },
        ],
        allowance: 500,
      }),
    ).toBe(true);
  });

  it("ignores disabled rows, which nobody can pick anyway", () => {
    expect(
      aiOperationWouldGoOffline({
        minimumChargeOf,
        models: [
          { modelId: "disabled", provider: "openrouter", priceUnits: 10, enabled: false },
          { modelId: "expensive", provider: "openrouter", priceUnits: 400, enabled: true },
        ],
        allowance: 500,
      }),
    ).toBe(true);
  });

  it("treats a model with no valid request shape as offline", () => {
    expect(
      aiOperationWouldGoOffline({
        minimumChargeOf: () => 0,
        models: [{ modelId: "unsupported", provider: "openrouter", priceUnits: 1, enabled: true }],
        allowance: 500,
      }),
    ).toBe(true);
  });

  it("says nothing about an operation with no rows", () => {
    // It falls back to the configured single model, which the settings page
    // validates against the allowance itself.
    expect(
      aiOperationWouldGoOffline({
        minimumChargeOf,
        models: [],
        allowance: 1,
      }),
    ).toBe(false);
  });
});
