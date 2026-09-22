import { describe, expect, it } from "vitest";
import { clearAiModelPricingCache, loadAiCostEstimates } from "../../packages/api/src/ai/model-pricing";
import { listGatewayVideoModels } from "../../packages/api/src/ai/providers/vercel-gateway/models";
import {
  gatewayDearestVideoRate,
  loadGatewayRateCard,
} from "../../packages/api/src/ai/providers/vercel-gateway/pricing";

// Hits Vercel AI Gateway's public model list for real, so it is opt-in:
//
//   TEST_VERCEL_GATEWAY_MODELS=1 vp exec vitest run tests/integration/ai-gateway-models-live.test.ts
//
// It needs no credentials — GET /v1/models is unauthenticated.
//
// This exists because `video_capabilities` and `supported_operations` appear
// nowhere in Vercel's documentation. They are observable only here, so the
// field names are unversioned and this is the only thing that would notice one
// being renamed. The assertions stay loose: the catalog changes weekly, and
// this is about the response *shape*, not about which models exist.
const describeLive = process.env.TEST_VERCEL_GATEWAY_MODELS
  ? describe
  : describe.skip;

describeLive("Vercel AI Gateway image prices against the live catalog", () => {
  it("estimates GPT Image 2 and a per-image model using the admin pricing path", async () => {
    clearAiModelPricingCache();
    const { entries } = await loadAiCostEstimates({
      modelsOf: (operation) => ["image.generate", "image.edit.restyle", "image.edit.remove_object"].includes(operation)
        ? ["openai/gpt-image-2", "bytedance/seedream-4.5"].map((modelId) => ({
            modelId,
            provider: "vercel-gateway",
          }))
        : [],
    });

    expect(entries).toHaveLength(6);
    for (const entry of entries) {
      expect(entry.estimate, `${entry.operation}: ${entry.model}`).toMatchObject({
        status: "estimated",
      });
      if (entry.estimate.status !== "estimated") continue;
      expect(entry.estimate.usdMin).toBeGreaterThan(0);
      expect(entry.estimate.usdMax).toBeLessThan(100);
    }
  });
});

describeLive("Vercel AI Gateway video models against the live list", () => {
  it.each([
    ["video.generate", "bytedance/seedance-2.0"],
    ["video.generate", "bytedance/seedance-2.5"],
    ["video.extend", "bytedance/seedance-2.5"],
    ["video.generate", "bfl/flux-3-video"],
    ["video.extend", "bfl/flux-3-video"],
  ])("estimates the published price for %s on %s", async (
    operation,
    modelId,
  ) => {
    clearAiModelPricingCache();
    const { entries } = await loadAiCostEstimates({
      modelsOf: (candidate) =>
        candidate === operation
          ? [{ modelId, provider: "vercel-gateway" }]
          : [],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.estimate).toMatchObject({ status: "estimated" });
    if (entries[0]?.estimate.status !== "estimated") return;
    expect(entries[0].estimate.usdMin).toBeGreaterThan(0);
  });

  it("still publishes capabilities this service can read", async () => {
    const models = await listGatewayVideoModels();

    // The catalog held 35 video models in 2026-09. A handful would mean the
    // filter or the type field moved.
    expect(models.length).toBeGreaterThan(10);

    // Every model says something about its shapes. If this goes empty across
    // the board, `video_capabilities` has been renamed and every model would
    // silently become "unrestricted".
    const described = models.filter(
      (model) =>
        model.supportedResolutions !== null &&
        model.supportedAspectRatios !== null &&
        model.supportedDurations !== null,
    );
    expect(described.length).toBeGreaterThan(models.length / 2);

    // At least one model this service can actually offer.
    const usable = models.filter(
      (model) =>
        model.supportsPromptToVideo !== false &&
        (model.supportedResolutions?.length ?? 1) > 0,
    );
    expect(usable.length).toBeGreaterThan(0);

    // Resolutions are folded onto this service's own names, so nothing the
    // price is not set against can reach a screen.
    for (const model of models) {
      for (const resolution of model.supportedResolutions ?? []) {
        expect(["480p", "720p", "1080p", "2K"]).toContain(resolution);
      }
    }
  });

  // The rate card route is undocumented too, and it answers in OpenRouter's
  // shape rather than in the one Vercel's own pricing page describes. If that
  // changes, the console reports every Gateway model as having no price, which
  // is quiet enough to go unnoticed.
  it("still publishes a per-second rate this service can read", async () => {
    const models = await listGatewayVideoModels();
    const priced = await Promise.all(
      models.slice(0, 5).map(async (model) => {
        const card = await loadGatewayRateCard(model.id);
        return gatewayDearestVideoRate(card);
      }),
    );

    const known = priced.filter((rate) => rate !== null);
    expect(known.length).toBeGreaterThan(0);
    for (const rate of known) {
      expect(rate!.usdPerSecond).toBeGreaterThan(0);
    }
  });

  // The allowances are undocumented like the rest of the block. If they stop
  // being published, every model silently falls back to this service's own
  // ceilings — which is safe, but throws away most of what the catalog offers.
  it("still publishes what each model will take", async () => {
    const models = await listGatewayVideoModels();
    const stated = models.filter(
      (model) => model.inputLimits.maxImages !== null,
    );

    // 29 of 35 published an image count in 2026-09. A handful would mean the
    // field moved.
    expect(stated.length).toBeGreaterThan(models.length / 2);
    for (const model of stated) {
      expect(model.inputLimits.maxImages!).toBeGreaterThan(0);
    }
    // At least one model takes more pictures than a single service-wide
    // number would have allowed, which is the whole reason these are read.
    expect(
      stated.some((model) => model.inputLimits.maxImages! > 3),
    ).toBe(true);
  });
});
