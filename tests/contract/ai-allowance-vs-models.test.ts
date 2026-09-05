import { describe, expect, it } from "vitest";
import { AI_DEFAULT_OPERATION_MODELS, aiMinimumChargeOf } from "@beutl/core";
import { aiOperationsGoingOffline } from "../../apps/admin/src/lib/ai-operation-model-changes";

const minimumChargeOf = (operation: string, priceUnits: number) =>
  aiMinimumChargeOf(operation, priceUnits) ?? priceUnits;

describe("an allowance measured against the models on offer", () => {
  it("names the operations it would take offline", () => {
    // A valid video needs at least one second, so less than 40 units takes it
    // offline.
    const offline = aiOperationsGoingOffline({
      minimumChargeOf,
      modelsByOperation: {
        "video.generate": [{ priceUnits: 40, enabled: true }],
        "image.generate": [{ priceUnits: 20, enabled: true }],
      },
      allowance: 39,
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
