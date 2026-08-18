import { beforeEach, describe, expect, it } from "vitest";
import { setDbProvider, upsertAiOperationModel } from "@beutl/db";
import { loadAiModelCatalog } from "@beutl/api";
import { AI_DEFAULT_OPERATION_MODELS, AI_OPERATIONS } from "@beutl/core";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const OPERATION = "image.generate";

async function register(
  modelId: string,
  priceUnits: number,
  overrides: { sortOrder?: number; enabled?: boolean; displayName?: string } = {},
) {
  await upsertAiOperationModel({
    operation: OPERATION,
    modelId,
    priceUnits,
    displayName: overrides.displayName ?? null,
    sortOrder: overrides.sortOrder ?? 0,
    enabled: overrides.enabled ?? true,
    updatedBy: "admin-1",
  });
}

describe("AI model catalog", () => {
  beforeEach(() => {
    const memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
  });

  it("falls back to the built-in model for an operation with no rows", async () => {
    const catalog = await loadAiModelCatalog();

    // The migration seeds a row per operation, so this is reached only by one
    // added in code before an administrator has registered anything.
    for (const operation of AI_OPERATIONS) {
      const entry = catalog.getDefault(operation);
      expect(entry.modelId).toBe(AI_DEFAULT_OPERATION_MODELS[operation].model);
      expect(entry.priceUnits).toBe(AI_DEFAULT_OPERATION_MODELS[operation].price);
      expect(catalog.list(operation)).toHaveLength(1);
    }
  });

  it("makes the lowest sort order the default", async () => {
    await register("openai/gpt-image-1", 20, { sortOrder: 1 });
    await register("bytedance-seed/seedream-4.5", 8, { sortOrder: 0 });

    const catalog = await loadAiModelCatalog();

    expect(catalog.getDefault(OPERATION).modelId).toBe(
      "bytedance-seed/seedream-4.5",
    );
    expect(catalog.list(OPERATION).map((entry) => entry.modelId)).toEqual([
      "bytedance-seed/seedream-4.5",
      "openai/gpt-image-1",
    ]);
  });

  it("resolves a named model and refuses one that is unknown or disabled", async () => {
    await register("openai/gpt-image-1", 20);
    await register("retired/model", 30, { enabled: false, sortOrder: 1 });

    const catalog = await loadAiModelCatalog();

    expect(catalog.resolve(OPERATION, "openai/gpt-image-1")?.priceUnits).toBe(20);
    // Falling back to the default here would charge for a model the caller did
    // not ask for.
    expect(catalog.resolve(OPERATION, "retired/model")).toBeNull();
    expect(catalog.resolve(OPERATION, "never/registered")).toBeNull();
    expect(catalog.resolve(OPERATION)?.modelId).toBe("openai/gpt-image-1");
  });

  it("ranks cost by price, not by display order", async () => {
    await register("cheap/model", 5, { sortOrder: 2 });
    await register("dear/model", 40, { sortOrder: 0 });
    await register("middling/model", 20, { sortOrder: 1 });

    const catalog = await loadAiModelCatalog();
    const tierOf = new Map(
      catalog.list(OPERATION).map((entry) => [entry.modelId, entry.costTier]),
    );

    expect(tierOf.get("cheap/model")).toBe("low");
    expect(tierOf.get("middling/model")).toBe("medium");
    expect(tierOf.get("dear/model")).toBe("high");
  });

  it("splits two models into low and high, and leaves one untiered", async () => {
    await register("cheap/model", 5);
    await register("dear/model", 40, { sortOrder: 1 });

    const two = await loadAiModelCatalog();
    expect(two.resolve(OPERATION, "cheap/model")?.costTier).toBe("low");
    expect(two.resolve(OPERATION, "dear/model")?.costTier).toBe("high");

    // One model has nothing to be higher or lower than.
    expect(
      two.resolve("video.generate", "google/veo-3.1")?.costTier,
    ).toBeNull();
  });

  it("shows the model id when no display name was given", async () => {
    await register("openai/gpt-image-1", 20);
    await register("bytedance-seed/seedream-4.5", 8, {
      sortOrder: 1,
      displayName: "Seedream (fast)",
    });

    const catalog = await loadAiModelCatalog();

    expect(catalog.resolve(OPERATION, "openai/gpt-image-1")?.displayName).toBe(
      "openai/gpt-image-1",
    );
    expect(
      catalog.resolve(OPERATION, "bytedance-seed/seedream-4.5")?.displayName,
    ).toBe("Seedream (fast)");
  });

  it("ignores a row for an operation that no longer exists", async () => {
    await upsertAiOperationModel({
      operation: "image.retired",
      modelId: "openai/gpt-image-1",
      priceUnits: 20,
      displayName: null,
      sortOrder: 0,
      enabled: true,
      updatedBy: "admin-1",
    });

    const catalog = await loadAiModelCatalog();

    expect(catalog.operations()).toEqual([...AI_OPERATIONS]);
  });
});
