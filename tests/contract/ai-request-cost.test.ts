import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { consumeUsage, getCreditAccount, setDbProvider, upsertAiOperationModel, upsertSubscription } from "@beutl/db";
import { saveAiImage, saveAiVideo, setR2BucketProvider, v3 } from "@beutl/api";
import { createReservedAiJob } from "../../packages/api/src/ai/credits";
import { quoteAiUsageReservation } from "../../packages/api/src/ai/usage-cost";
import { clearAiModelPricingCache, loadAiCostEstimates } from "../../packages/api/src/ai/model-pricing";
import { clearAiImageModelCapabilitiesCache } from "../../packages/api/src/ai/image-model-capabilities";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const imageModel = "test/request-image";
const videoModel = "test/request-video";
const imageEndpoint = (inputPrice = 0.01, maxReferences = 4) => ({
  provider_name: "test", provider_slug: "test", provider_tag: "test",
  supported_parameters: {
    input_references: { type: "range", min: 0, max: maxReferences },
    aspect_ratio: { type: "enum", values: ["1:1", "16:9"] },
  },
  allowed_passthrough_parameters: [], supports_streaming: false,
  pricing: [
    { billable: "input_image", unit: "image", cost_usd: inputPrice },
    { billable: "output_image", unit: "image", cost_usd: 0.04 },
  ],
});
const video = {
  id: videoModel, canonical_slug: videoModel, name: "Request video", created: 1,
  supported_resolutions: ["720p", "1080p"], supported_durations: [5],
  supported_aspect_ratios: ["16:9", "1:1"], supported_frame_images: [],
  supported_sizes: null, generate_audio: true, seed: true, allowed_passthrough_parameters: [],
  pricing_skus: {
    duration_seconds_720p_without_audio: "0.01", duration_seconds_720p_with_audio: "0.02",
    duration_seconds_1080p_without_audio: "0.03", duration_seconds_1080p_with_audio: "0.04",
  },
};
const userId = "request-cost-user";
const period = { start: new Date(Date.now() - 86_400_000), end: new Date(Date.now() + 86_400_000) };
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")).buffer;

describe("request-shaped AI reservation estimates", () => {
  let memory: ReturnType<typeof createInMemoryPrisma>;
  beforeEach(() => {
    memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
    setR2BucketProvider(() => ({ put: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) }));
    clearAiModelPricingCache();
    clearAiImageModelCapabilitiesCache();
    vi.stubEnv("JWT_SECRET", "request-cost-test-secret");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/images/models/test/request-image/endpoints")) {
        return Response.json({ id: imageModel, endpoints: [imageEndpoint()] });
      }
      if (url.endsWith("/videos/models")) return Response.json({ data: [video] });
      throw new Error(`Unexpected pricing request: ${url}`);
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
    clearAiModelPricingCache(); clearAiImageModelCapabilitiesCache();
  });

  it.each([[0, 0.04, 0.048], [1, 0.05, 0.06], [4, 0.08, 0.096]])(
    "prices only the %s submitted image references", async (count, estimate, reservation) => {
      expect(await quoteAiUsageReservation({
        kind: "image", modelId: imageModel, provider: "openrouter",
        inputParams: { aspectRatio: "1:1", references: Array.from({ length: count }, () => ({ filename: "ref.png" })) },
      })).toEqual({ operation: "image.generate", estimatedProviderCostUsd: estimate, providerCostUsd: reservation });
    },
  );

  it("does not reuse an endpoint's maximum reference count for a concrete request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      id: imageModel, endpoints: [imageEndpoint(), imageEndpoint(0.1, 1)],
    })));
    expect(await quoteAiUsageReservation({
      kind: "image", modelId: imageModel, provider: "openrouter",
      inputParams: { references: [{}, {}, {}] },
    })).toMatchObject({ estimatedProviderCostUsd: 0.07, providerCostUsd: 0.084 });
  });

  it.each([
    ["720p", false, 0.05], ["720p", true, 0.1],
    ["1080p", false, 0.15], ["1080p", true, 0.2],
  ] as const)("prices a 5-second %s video with audio=%s", async (resolution, generateAudio, expected) => {
    expect(await quoteAiUsageReservation({
      kind: "video", modelId: videoModel, provider: "openrouter",
      inputParams: { durationSeconds: 5, resolution, generateAudio },
    })).toMatchObject({ estimatedProviderCostUsd: expected });
  });

  it("uses generation defaults when optional shape fields are absent", async () => {
    expect(await quoteAiUsageReservation({ kind: "image", modelId: imageModel, provider: "openrouter" }))
      .toMatchObject({ estimatedProviderCostUsd: 0.04 });
    expect(await quoteAiUsageReservation({ kind: "video", modelId: videoModel, provider: "openrouter", inputParams: { durationSeconds: 5 } }))
      .toMatchObject({ estimatedProviderCostUsd: 0.1 });
  });

  it("keeps one source image in an image-edit quote", async () => {
    expect(await quoteAiUsageReservation({ kind: "image_edit", modelId: imageModel, provider: "openrouter", inputParams: { task: "restyle" } }))
      .toMatchObject({ estimatedProviderCostUsd: 0.05, providerCostUsd: 0.06 });
  });

  it("excludes image endpoints that cannot serve the submitted aspect ratio", async () => {
    const cheap = imageEndpoint();
    const expensive = imageEndpoint();
    expensive.pricing[1].cost_usd = 0.4;
    expensive.supported_parameters.aspect_ratio.values = ["16:9"];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: imageModel, endpoints: [cheap, expensive] })));
    expect(await quoteAiUsageReservation({ kind: "image", modelId: imageModel, provider: "openrouter", inputParams: { aspectRatio: "1:1" } }))
      .toMatchObject({ estimatedProviderCostUsd: 0.04 });
  });

  it("selects the requested Gateway resolution and keeps other tiers out of its quote", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: { endpoints: [{ pricing: { video_duration_pricing: [
      { resolution: "hd", cost_per_second: "0.01" }, { resolution: "fhd", cost_per_second: "0.03" },
    ] } }] } })));
    for (const [resolution, expected] of [["720p", 0.05], ["1080p", 0.15]] as const) {
      expect(await quoteAiUsageReservation({ kind: "video", modelId: videoModel, provider: "vercel-gateway", inputParams: { durationSeconds: 5, resolution } }))
        .toMatchObject({ estimatedProviderCostUsd: expected });
    }
    expect(await quoteAiUsageReservation({ kind: "video", modelId: videoModel, provider: "vercel-gateway", inputParams: { durationSeconds: 5, resolution: "2K" } })).toBeNull();
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
  });

  it.each(["openrouter", "vercel-gateway"])("sizes %s video token quotes using the submitted aspect ratio without changing cached rates", async (provider) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(provider === "openrouter"
      ? { data: [{ ...video, pricing_skus: { video_tokens: "0.00001" } }] }
      : { data: { endpoints: [{ pricing: { video_token_pricing: { tiers: [
        { resolution: "720p", no_video_input: { cost_per_million_tokens: "10" } },
        { resolution: "1080p", no_video_input: { cost_per_million_tokens: "10" } },
      ] } } }] } },
    )));
    for (const [aspectRatio, expected] of [["16:9", 1.08], ["1:1", 0.6075], ["4:3", 0.81], ["9:16", 1.08]] as const) {
      expect(await quoteAiUsageReservation({ kind: "video", modelId: videoModel, provider, inputParams: { durationSeconds: 5, resolution: "720p", generateAudio: false, aspectRatio } }))
        .toMatchObject({ estimatedProviderCostUsd: expected });
    }
    const admin = await loadAiCostEstimates({ modelsOf: (operation) => operation === "video.generate" ? [{ modelId: videoModel, provider }] : [] });
    expect(admin.entries[0].estimate).toMatchObject({ usdMax: 0.486 });
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
  });

  it.each(["edit", "extend", "motion"])("retains source-video pricing for %s when the source determines the output shape", async (mode) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: { endpoints: [{ pricing: { video_token_pricing: { tiers: [
      { resolution: "720p", no_video_input: { cost_per_million_tokens: "10" }, with_video_input: { cost_per_million_tokens: "8" } },
      { resolution: "1080p", no_video_input: { cost_per_million_tokens: "12" }, with_video_input: { cost_per_million_tokens: "9" } },
    ] } } }] } })));
    expect(await quoteAiUsageReservation({ kind: "video", modelId: videoModel, provider: "vercel-gateway", inputParams: { durationSeconds: 5, mode } }))
      .toMatchObject({ operation: `video.${mode}`, estimatedProviderCostUsd: 2.187 });
  });

  it("keeps admin maximum-shape estimates independent of cached request quotes", async () => {
    await quoteAiUsageReservation({ kind: "image", modelId: imageModel, provider: "openrouter" });
    await quoteAiUsageReservation({ kind: "video", modelId: videoModel, provider: "openrouter", inputParams: { durationSeconds: 5, resolution: "720p", generateAudio: false } });
    const admin = await loadAiCostEstimates({ modelsOf: (operation) =>
      operation === "image.generate" ? [{ modelId: imageModel, provider: "openrouter" }]
        : operation === "video.generate" ? [{ modelId: videoModel, provider: "openrouter" }] : [],
    });
    expect(admin.entries.map((entry) => entry.estimate)).toEqual([
      expect.objectContaining({ status: "estimated", usdMax: 0.08 }),
      expect.objectContaining({ status: "estimated", usdMax: 0.04 }),
    ]);
  });

  async function activate(operation: string, modelId: string, consumed: number) {
    await upsertSubscription({ userId, stripeSubscriptionId: "sub_request_cost", status: "active", planId: "pro", billingOfferId: "offer_pro_test", currentPeriodStart: period.start, currentPeriodEnd: period.end });
    await upsertAiOperationModel({ operation, modelId, provider: "openrouter", usagePercent: 100, priceUnits: 100, displayName: null, enabled: true, sortOrder: 0, updatedBy: "admin" });
    await consumeUsage({ userId, amount: consumed, monthlyUsageLimit: 500, usagePeriod: period, aiJobId: "setup" });
  }

  async function availability(body: object) {
    const token = await sign({ "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier": userId, exp: Math.floor(Date.now() / 1000) + 300 }, "request-cost-test-secret", "HS256");
    return new Hono().basePath("/api/v3").route("/", v3).request("/api/v3/user/ai-availability", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  }

  it.each([
    { kind: "image", operation: "image.generate", modelId: imageModel, consumed: 495, inputParams: { aspectRatio: "1:1" }, availabilityShape: { referenceImages: 0, aspectRatio: "1:1" }, expected: 4, reserved: 4.8 },
    { kind: "video", operation: "video.generate", modelId: videoModel, consumed: 490, inputParams: { durationSeconds: 5, resolution: "720p", generateAudio: false }, availabilityShape: { durationSeconds: 5, resolution: "720p", generateAudio: false }, expected: 5, reserved: 6 },
  ])("admits an affordable $kind and settles its own estimate when actual cost is absent", async (test) => {
    await activate(test.operation, test.modelId, test.consumed);
    const preflight = await availability({ operation: test.operation, model: test.modelId, ...test.availabilityShape });
    expect(preflight.status).toBe(200);
    expect(await preflight.json()).toEqual({ available: true });
    const expensiveShape = test.kind === "image" ? { referenceImages: 4 } : { durationSeconds: 5, resolution: "1080p", generateAudio: true };
    const expensive = await availability({ operation: test.operation, model: test.modelId, ...expensiveShape });
    expect(expensive.status).toBe(200);
    expect(await expensive.json()).toEqual({ available: false });
    const result = await createReservedAiJob({ userId, kind: test.kind, provider: "openrouter", status: "running", model: test.modelId, inputParams: test.inputParams });
    expect(result).toMatchObject({ ok: true, job: { estimatedUsageUnits: test.expected, reservedUsageUnits: test.reserved } });
    if (!result.ok) throw new Error("Expected an affordable reservation");
    const save = test.kind === "image" ? saveAiImage : saveAiVideo;
    await save({ jobId: result.job.id, userId, bytes: PNG, mimeType: test.kind === "image" ? "image/png" : "video/mp4", filename: "result" });
    expect(memory.state.aiJobs.get(result.job.id)?.usageUnits).toBe(test.expected);
    expect((await getCreditAccount({ userId })).monthlyUsageUsed).toBe(test.consumed + test.expected);
  });

  it.each([
    { operation: "image.generate", referenceImages: -1 },
    { operation: "image.generate", referenceImages: 5 },
    { operation: "image.generate", referenceImages: 0.5 },
    { operation: "video.generate", durationSeconds: 5, resolution: "4K" },
    { operation: "video.generate", durationSeconds: 5, generateAudio: "false" },
    { operation: "video.generate", durationSeconds: 5, aspectRatio: "21:9" },
  ])("rejects an invalid availability shape %#", async (body) => {
    expect((await availability(body)).status).toBe(400);
  });
});
