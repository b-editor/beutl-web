import { describe, expect, it } from "vitest";
import { AI_DEFAULT_OPERATION_MODELS, aiMinimumChargeOf } from "@beutl/core";
import {
  aiOperationsGoingOffline,
  orderWithDefaultFirst,
  sortOrderForSavedModel,
} from "../../apps/admin/src/lib/ai-operation-model-changes";

const minimumChargeOf = (operation: string, priceUnits: number) =>
  aiMinimumChargeOf(operation, priceUnits) ?? priceUnits;

describe("where a saved model lands in the order", () => {
  const rows = [
    { modelId: "first/model", sortOrder: 0 },
    { modelId: "second/model", sortOrder: 1 },
  ];

  it("appends one that is not registered yet", () => {
    // Landing in front of the default would change what every request that
    // names no model runs on.
    expect(sortOrderForSavedModel({ rows, modelId: "third/model" })).toBe(2);
  });

  it("keeps the place of one being edited", () => {
    expect(sortOrderForSavedModel({ rows, modelId: "first/model" })).toBe(0);
  });

  it("starts at zero for the first model of an operation", () => {
    expect(sortOrderForSavedModel({ rows: [], modelId: "only/model" })).toBe(0);
  });
});

describe("making a model the default", () => {
  const rows = [
    { modelId: "first/model" },
    { modelId: "second/model" },
    { modelId: "third/model" },
  ];

  it("moves it to the front and keeps the rest in order", () => {
    // Renumbering the whole operation is what keeps "lowest wins"
    // unambiguous: two rows sharing the lowest order would leave the default
    // to the id tie-break.
    expect(orderWithDefaultFirst({ rows, modelId: "third/model" })).toEqual([
      "third/model",
      "first/model",
      "second/model",
    ]);
  });

  it("changes nothing for a model that is not registered", () => {
    expect(
      orderWithDefaultFirst({ rows, modelId: "never/registered" }),
    ).toEqual(["first/model", "second/model", "third/model"]);
  });
});

describe("an allowance measured against the models on offer", () => {
  it("names the operations it would take offline", () => {
    // A video is charged for at least four seconds, so 40 units a second needs
    // 160 of the allowance.
    const offline = aiOperationsGoingOffline({
      minimumChargeOf,
      modelsByOperation: {
        "video.generate": [{ priceUnits: 40, enabled: true }],
        "image.generate": [{ priceUnits: 20, enabled: true }],
      },
      allowance: 100,
    });

    expect(offline).toEqual(["video.generate"]);
  });

  it("leaves an operation alone while one model still fits", () => {
    expect(
      aiOperationsGoingOffline({
        minimumChargeOf,
        modelsByOperation: {
          "image.generate": [
            { priceUnits: 20, enabled: true },
            { priceUnits: 400, enabled: true },
          ],
        },
        allowance: 100,
      }),
    ).toEqual([]);
  });

  it("ignores models nobody can pick", () => {
    expect(
      aiOperationsGoingOffline({
        minimumChargeOf,
        modelsByOperation: {
          "image.generate": [
            { priceUnits: 20, enabled: false },
            { priceUnits: 400, enabled: true },
          ],
        },
        allowance: 100,
      }),
    ).toEqual(["image.generate"]);
  });

  it("passes the built-in models at the built-in allowance", () => {
    // The shipped defaults have to be startable on the shipped allowance, or a
    // fresh deployment cannot save its own settings.
    const offline = aiOperationsGoingOffline({
      minimumChargeOf,
      modelsByOperation: Object.fromEntries(
        Object.entries(AI_DEFAULT_OPERATION_MODELS).map(
          ([operation, defaults]) => [
            operation,
            [{ priceUnits: defaults.price, enabled: true }],
          ],
        ),
      ),
      allowance: 500,
    });

    expect(offline).toEqual([]);
  });
});
