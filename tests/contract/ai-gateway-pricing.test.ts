import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addPurchasedCredits,
  getCreditAccount,
  setDbProvider,
  upsertAiOperationModel,
  upsertSubscription,
} from "@beutl/db";
import { createReservedAiJob } from "../../packages/api/src/ai/credits";
import { canStartAiOperation } from "../../packages/api/src/ai/entitlements";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";
import {
  gatewayDearestVideoRate,
  loadGatewayImagePrices,
  loadGatewayRateCard,
} from "../../packages/api/src/ai/providers/vercel-gateway/pricing";
import { AiProviderError } from "../../packages/api/src/ai/providers/errors";
import {
  clearAiModelPricingCache,
  loadAiCostEstimates,
} from "../../packages/api/src/ai/model-pricing";

// Copied from the live GET /v1/models/{id}/endpoints responses (2026-09-19).
// The route answers in OpenRouter's shape, which is convenient and entirely
// undocumented, so these are the payloads the parser actually has to survive.

// Publishes a rate for a resolution this service never asks for (768p) next to
// one it does, plus an untagged rate that applies to anything.
const minimaxH3 = {
  data: {
    id: "minimax/minimax-h3",
    endpoints: [
      {
        pricing: {
          prompt: "0",
          completion: "0",
          video_duration_pricing: [
            { resolution: "2k", cost_per_second: "0.13" },
            { resolution: "768p", cost_per_second: "0.08" },
            { cost_per_second: "0.13" },
          ],
        },
      },
    ],
  },
};

const grokImagineVideo = {
  data: {
    id: "spacexai/grok-imagine-video",
    endpoints: [
      {
        pricing: {
          prompt: "0",
          completion: "0",
          video_duration_pricing: [
            { resolution: "480p", cost_per_second: "0.05" },
            { resolution: "720p", cost_per_second: "0.07" },
          ],
        },
      },
    ],
  },
};

// Kling tags its rates by a `mode` this service does not choose between, so
// neither entry carries a resolution at all.
const klingMotionControl = {
  data: {
    id: "klingai/kling-v3.0-motion-control",
    endpoints: [
      {
        pricing: {
          prompt: "0",
          completion: "0",
          video_duration_pricing: [
            { mode: "std", cost_per_second: "0.126" },
            { mode: "pro", cost_per_second: "0.168" },
          ],
        },
      },
    ],
  },
};

const seedance25 = {
  data: {
    id: "bytedance/seedance-2.5",
    endpoints: [
      {
        pricing: {
          prompt: "0",
          completion: "0",
          video_token_pricing: {
            tiers: [
              {
                resolution: "720p",
                no_video_input: { cost_per_million_tokens: "10.7" },
                with_video_input: { cost_per_million_tokens: "6.4" },
              },
              {
                resolution: "1080p",
                no_video_input: { cost_per_million_tokens: "11.7" },
                with_video_input: { cost_per_million_tokens: "7" },
              },
            ],
          },
        },
      },
    ],
  },
};

const flux3WithoutApiPrices = {
  data: {
    id: "bfl/flux-3-video",
    endpoints: [{ pricing: { prompt: "0", completion: "0" } }],
  },
};

const respondWith = (body: unknown, status = 200) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

describe("reading a Gateway rate card", () => {
  it("reads the per-second video rates and the token rates", async () => {
    const card = await loadGatewayRateCard(
      "minimax/minimax-h3",
      respondWith(minimaxH3),
    );

    expect(card.videoRates).toEqual([
      { label: "2k", usdPerSecond: 0.13 },
      { label: "768p", usdPerSecond: 0.08 },
      { label: null, usdPerSecond: 0.13 },
    ]);
  });

  it("converts Seedance token tiers into resolution-specific second rates", async () => {
    const card = await loadGatewayRateCard(
      "bytedance/seedance-2.5",
      respondWith(seedance25),
    );

    expect(card.videoRates).toEqual([
      {
        label: "720p",
        usdPerSecond: 0.23112,
        videoInput: false,
        tokenCalculation: { costPerMillionTokens: 10.7, tokensPerSecond: 21600, resolution: "720p" },
      },
      {
        label: "720p",
        usdPerSecond: 0.13824,
        videoInput: true,
        tokenCalculation: { costPerMillionTokens: 6.4, tokensPerSecond: 21600, resolution: "720p" },
      },
      {
        label: "1080p",
        usdPerSecond: 0.56862,
        videoInput: false,
        tokenCalculation: { costPerMillionTokens: 11.7, tokensPerSecond: 48600, resolution: "1080p" },
      },
      {
        label: "1080p",
        usdPerSecond: 0.3402,
        videoInput: true,
        tokenCalculation: { costPerMillionTokens: 7, tokensPerSecond: 48600, resolution: "1080p" },
      },
    ]);
  });

  it("uses the verified FLUX 3 full-render rates while its API price is empty", async () => {
    const card = await loadGatewayRateCard(
      "bfl/flux-3-video",
      respondWith(flux3WithoutApiPrices),
    );

    expect(card.videoRates).toEqual([
      { label: "hd", usdPerSecond: 0.17, videoInput: false },
      { label: "fhd", usdPerSecond: 0.29, videoInput: false },
      { label: "hd", usdPerSecond: 0.41, videoInput: true },
      { label: "fhd", usdPerSecond: 0.53, videoInput: true },
    ]);
  });

  it.each(["2k", "2K"])("keeps %s token tiers and their source-video rates", async (resolution) => {
    const card = await loadGatewayRateCard("test/2k-video", respondWith({
      data: { endpoints: [{ pricing: { video_token_pricing: { tiers: [
        { resolution: "1080p", no_video_input: { cost_per_million_tokens: "10" } },
        {
          resolution,
          no_video_input: { cost_per_million_tokens: "12" },
          with_video_input: { cost_per_million_tokens: "8" },
        },
      ] } } }] },
    }));

    expect(gatewayDearestVideoRate(card, { videoInput: false })).toEqual({
      label: resolution,
      usdPerSecond: 1.0368,
      videoInput: false,
      tokenCalculation: { costPerMillionTokens: 12, tokensPerSecond: 86400, resolution: "2K" },
    });
    expect(gatewayDearestVideoRate(card, { videoInput: true })).toEqual({
      label: resolution,
      usdPerSecond: 0.6912,
      videoInput: true,
      tokenCalculation: { costPerMillionTokens: 8, tokensPerSecond: 86400, resolution: "2K" },
    });
  });

  it("takes the dearest endpoint when a model has several", async () => {
    // Nothing pins a request to one endpoint, so the margin has to hold
    // against the dearest of them.
    const card = await loadGatewayRateCard(
      "alibaba/qwen-3-235b",
      respondWith({
        data: {
          endpoints: [
            { pricing: { prompt: "0.00000009", completion: "0.00000055" } },
            { pricing: { prompt: "0.00000031", completion: "0.00000031" } },
          ],
        },
      }),
    );

    expect(card.promptUsd).toBe(0.00000031);
    expect(card.completionUsd).toBe(0.00000055);
  });

  it("carries the status so a missing model is told from an outage", async () => {
    // model_not_found and provider_unavailable read very differently in the
    // console: one says the registration is wrong, the other says to wait.
    await expect(
      loadGatewayRateCard("nope/nope", respondWith({ error: "x" }, 404)),
    ).rejects.toMatchObject({ httpStatus: 404 });

    await expect(
      loadGatewayRateCard("nope/nope", respondWith({ error: "x" }, 503)),
    ).rejects.toBeInstanceOf(AiProviderError);
  });

  it("keeps the rates that parsed when one entry does not", async () => {
    const card = await loadGatewayRateCard(
      "x/y",
      respondWith({
        data: {
          endpoints: [
            {
              pricing: {
                video_duration_pricing: [
                  { resolution: 42, cost_per_second: "0.07" },
                  { resolution: "720p", cost_per_second: "0.09" },
                  { resolution: "480p", cost_per_second: "not a number" },
                ],
              },
            },
          ],
        },
      }),
    );

    expect(card.videoRates).toEqual([{ label: "720p", usdPerSecond: 0.09 }]);
  });
});

describe("choosing the rate a request would be charged", () => {
  it("ignores a resolution this service never asks for", async () => {
    // 768p is dropped when a provider label is folded onto this service's
    // names, so a request can never be billed at that rate.
    const card = await loadGatewayRateCard(
      "minimax/minimax-h3",
      respondWith(minimaxH3),
    );

    expect(gatewayDearestVideoRate(card)).toEqual({
      label: "2k",
      usdPerSecond: 0.13,
    });
  });

  it("takes the dearest resolution a caller can ask for", async () => {
    const card = await loadGatewayRateCard(
      "spacexai/grok-imagine-video",
      respondWith(grokImagineVideo),
    );

    expect(gatewayDearestVideoRate(card)).toEqual({
      label: "720p",
      usdPerSecond: 0.07,
    });
  });

  it("counts variants this service does not pick between", async () => {
    // std and pro are both reachable, so the estimate has to assume pro.
    const card = await loadGatewayRateCard(
      "klingai/kling-v3.0-motion-control",
      respondWith(klingMotionControl),
    );

    expect(gatewayDearestVideoRate(card)).toEqual({
      label: null,
      usdPerSecond: 0.168,
    });
  });

  it("keeps token rates correlated with source-video use", async () => {
    const card = await loadGatewayRateCard(
      "bytedance/seedance-2.5",
      respondWith(seedance25),
    );

    expect(gatewayDearestVideoRate(card, { videoInput: false }))
      .toMatchObject({ label: "1080p", usdPerSecond: 0.56862 });
    expect(gatewayDearestVideoRate(card, { videoInput: true }))
      .toMatchObject({ label: "1080p", usdPerSecond: 0.3402 });
  });

  it("keeps FLUX 3 generation and continuation rates separate", async () => {
    const card = await loadGatewayRateCard(
      "bfl/flux-3-video",
      respondWith(flux3WithoutApiPrices),
    );

    expect(gatewayDearestVideoRate(card, { videoInput: false }))
      .toMatchObject({ label: "fhd", usdPerSecond: 0.29 });
    expect(gatewayDearestVideoRate(card, { videoInput: true }))
      .toMatchObject({ label: "fhd", usdPerSecond: 0.53 });
  });

  it("reports nothing rather than free when no rate applies", async () => {
    const card = await loadGatewayRateCard(
      "x/y",
      respondWith({
        data: {
          endpoints: [
            {
              pricing: {
                video_duration_pricing: [
                  { resolution: "4k", cost_per_second: "0.60" },
                  { resolution: "768p", cost_per_second: "0.08" },
                ],
              },
            },
          ],
        },
      }),
    );

    expect(gatewayDearestVideoRate(card)).toBeNull();
  });
});

describe("reading Gateway image prices", () => {
  it("keeps usable prices when another model or price field is malformed", async () => {
    const prices = await loadGatewayImagePrices(respondWith({
      data: [
        null,
        { id: 42 },
        { id: "bfl/flux-pro-1.1", type: "image", pricing: { image: 0.04 } },
        { id: "openai/gpt-image-2", type: "image", pricing: { image: {}, output: "0.00003" } },
        { id: "bfl/flux-2-flex", type: "image", pricing: {} },
      ],
    }));

    expect([...prices]).toEqual([
      ["bfl/flux-pro-1.1", { costUsd: 0.04, unit: "image" }],
      ["openai/gpt-image-2", { costUsd: 0.00003, unit: "token" }],
      ["bfl/flux-2-flex", null],
    ]);
  });

  it("does not invent image prices from text tokens or non-default variants", async () => {
    const prices = await loadGatewayImagePrices(respondWith({
      data: [
        { id: "text/model", type: "language", pricing: { output: "0.00003" } },
        { id: "image/variant", type: "image", pricing: {
          image_dimension_quality_pricing: [
            { size: "4K", cost: "0.24" },
            { size: "default", quality: "high", cost: "0.1" },
            { operation: "vectorize", cost: "0.15" },
          ],
        } },
      ],
    }));

    expect([...prices.values()]).toEqual([null, null]);
  });

  it.each(["0", "-0.1", "NaN", "Infinity", "", null])("rejects the unusable price %s", async (price) => {
    const prices = await loadGatewayImagePrices(respondWith({
      data: [{ id: "image/model", type: "image", pricing: { image: price, output: price } }],
    }));
    expect(prices.get("image/model")).toBeNull();
  });

  it("preserves transport failures and rejects unreadable catalogs", async () => {
    await expect(loadGatewayImagePrices(respondWith({}, 503)))
      .rejects.toMatchObject({ httpStatus: 503 });
    await expect(loadGatewayImagePrices(respondWith({ data: {} })))
      .rejects.toBeInstanceOf(AiProviderError);
  });
});

describe("costing an operation at the provider that serves it", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearAiModelPricingCache();
  });

  const stubGatewayFetch = (body: unknown) => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    );
    return calls;
  };

  const estimateFor = async (operation: string, modelId: string, provider: string) => {
    const costs = await loadAiCostEstimates({
      modelsOf: (candidate) =>
        candidate === operation ? [{ modelId, provider }] : [],
    });
    return costs.entries.find((entry) => entry.operation === operation)?.estimate;
  };

  it.each([0, 123])("uses the 2K tier for affordability and reservation with %s purchased units", async (credits) => {
    const memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
    const userId = "gateway-2k-reservation";
    const modelId = "test/2k-video";
    await upsertSubscription({
      userId, stripeSubscriptionId: "sub_gateway_2k", status: "active", planId: "pro",
      billingOfferId: "offer_pro_test",
      currentPeriodStart: new Date(Date.now() - 86_400_000),
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
    });
    await upsertAiOperationModel({
      operation: "video.generate", modelId, provider: "vercel-gateway",
      usagePercent: 100, priceUnits: 1, displayName: null,
      enabled: true, sortOrder: 0, updatedBy: "admin",
    });
    if (credits) await addPurchasedCredits({ userId, amount: credits, stripePaymentId: "pi_gateway_2k" });
    stubGatewayFetch({
      data: { endpoints: [{ pricing: { video_token_pricing: { tiers: [
        { resolution: "1080p", no_video_input: { cost_per_million_tokens: "10" } },
        { resolution: "2k", no_video_input: { cost_per_million_tokens: "12" } },
      ] } } }] },
    });

    // Five seconds reserve $1.0368 * 5 * 120% / $0.01 = 622.08 units.
    // The cheaper 1080p tier would incorrectly fit inside the 500-unit plan.
    expect(await canStartAiOperation(userId, {
      operation: "video.generate", model: modelId, durationSeconds: 5, resolution: "2K",
    })).toBe(credits > 0);
    const result = await createReservedAiJob({
      userId, kind: "video", provider: "vercel-gateway", status: "queued", model: modelId,
      inputParams: { mode: "generate", durationSeconds: 5, resolution: "2K" },
    });
    if (credits > 0) {
      expect(result).toMatchObject({
        ok: true,
        job: { reservedUsageUnits: 622.08, estimatedUsageUnits: 518.4 },
      });
      expect(await getCreditAccount({ userId })).toMatchObject({
        monthlyUsageUsed: 500, purchasedCredits: 0.92, purchasedCreditDebt: 0,
      });
    } else {
      expect(result).toEqual({ ok: false, errorCode: "aiUsageLimitExceeded", status: 402 });
      expect(memory.state.aiJobs.size).toBe(0);
      expect((await getCreditAccount({ userId })).monthlyUsageUsed).toBe(0);
    }
  });

  it.each(["image.generate", "video.generate"])("classifies malformed %s pricing replies as invalid responses", async (operation) => {
    for (const body of ['{"data":42}', 'not JSON']) {
      clearAiModelPricingCache();
      const fetchMock = vi.fn(async () => new Response(body, {
        headers: { "content-type": "application/json" },
      }));
      vi.stubGlobal("fetch", fetchMock);

      const expected = { status: "unknown", reason: "invalid_response" };
      expect(await estimateFor(operation, "x/y", "vercel-gateway")).toEqual(expected);
      expect(await estimateFor(operation, "x/y", "vercel-gateway")).toEqual(expected);
      expect(fetchMock).toHaveBeenCalledOnce();
    }
  });

  it("keeps network, HTTP and interrupted-body failures distinct from malformed prices", async () => {
    const cases = [
      async () => { throw new TypeError("connection failed"); },
      async () => new Response("not JSON", { status: 503 }),
      async () => new Response(new ReadableStream({
        start(controller) { controller.error(new Error("connection lost")); },
      })),
    ];
    for (const fetchImpl of cases) {
      clearAiModelPricingCache();
      vi.stubGlobal("fetch", fetchImpl);
      expect(await estimateFor("image.generate", "x/y", "vercel-gateway"))
        .toEqual({ status: "unknown", reason: "provider_unavailable" });
    }
  });

  it("prices a Gateway video model instead of calling it missing", async () => {
    // The regression this exists for: the estimate used to be looked up in
    // OpenRouter's catalog whatever the row said, so every Gateway model was
    // reported as one that does not exist.
    const calls = stubGatewayFetch(minimaxH3);

    const estimate = await estimateFor(
      "video.generate",
      "minimax/minimax-h3",
      "vercel-gateway",
    );

    expect(estimate).toEqual({
      status: "estimated",
      usdMin: 0.13,
      usdMax: 0.13,
      assumptions: [{ kind: "videoSku", value: "2k" }],
    });
    expect(calls.every((url) => url.includes("ai-gateway.vercel.sh"))).toBe(true);
  });

  it.each([
    ["bytedance/seedance-2.0", "7.7", 0.37422],
    ["bytedance/seedance-2.5", "11.7", 0.56862],
  ])("prices %s from its 1080p video-token tier", async (
    modelId,
    costPerMillionTokens,
    expected,
  ) => {
    stubGatewayFetch({
      data: {
        id: modelId,
        endpoints: [{
          pricing: {
            video_token_pricing: {
              tiers: [{
                resolution: "1080p",
                no_video_input: { cost_per_million_tokens: costPerMillionTokens },
                with_video_input: { cost_per_million_tokens: "1" },
              }],
            },
          },
        }],
      },
    });

    const estimate = await estimateFor(
      "video.generate",
      modelId,
      "vercel-gateway",
    );
    expect(estimate).toMatchObject({
      status: "estimated",
      assumptions: [
        { kind: "videoSku", value: "1080p" },
        { kind: "videoTokens", tokensPerSecond: 48600, resolution: "1080p" },
      ],
    });
    if (estimate?.status !== "estimated") return;
    expect(estimate.usdMin).toBeCloseTo(expected, 8);
    expect(estimate.usdMax).toBeCloseTo(expected, 8);
  });

  it("prices FLUX 3 generation from its verified full-render FHD rate", async () => {
    stubGatewayFetch(flux3WithoutApiPrices);

    expect(await estimateFor("video.generate", "bfl/flux-3-video", "vercel-gateway"))
      .toEqual({
        status: "estimated",
        usdMin: 0.29,
        usdMax: 0.29,
        assumptions: [{ kind: "videoSku", value: "fhd" }],
      });
  });

  it("prices FLUX 3 extension from its verified continuation FHD rate", async () => {
    stubGatewayFetch(flux3WithoutApiPrices);

    expect(await estimateFor("video.extend", "bfl/flux-3-video", "vercel-gateway"))
      .toEqual({
        status: "estimated",
        usdMin: 0.53,
        usdMax: 0.53,
        assumptions: [{ kind: "videoSku", value: "fhd" }],
      });
  });

  it("prices the three source-video operations as video", async () => {
    // They are metered per second off the same rate card. Matching only
    // video.generate sent them down the text path, where the lookup 404s.
    for (const operation of ["video.edit", "video.extend", "video.motion"]) {
      clearAiModelPricingCache();
      stubGatewayFetch(klingMotionControl);

      const estimate = await estimateFor(
        operation,
        "klingai/kling-v3.0-motion-control",
        "vercel-gateway",
      );

      expect(estimate, operation).toEqual({
        status: "estimated",
        usdMin: 0.168,
        usdMax: 0.168,
        assumptions: [],
      });
      vi.unstubAllGlobals();
    }
  });

  it("reports an unpublished image price separately from a lookup failure", async () => {
    stubGatewayFetch({
      data: [{ id: "bfl/flux-2-flex", type: "image", pricing: {} }],
    });

    expect(
      await estimateFor("image.generate", "bfl/flux-2-flex", "vercel-gateway"),
    ).toEqual({ status: "unknown", reason: "price_not_published" });
  });

  it("reads image prices from the model catalog rather than the zero endpoint prices", async () => {
    const calls = stubGatewayFetch({
      data: [{
        id: "bytedance/seedream-4.5",
        type: "image",
        pricing: { image: "0.04" },
      }],
    });

    for (const operation of ["image.generate", "image.edit.restyle", "image.edit.remove_object"]) {
      expect(await estimateFor(operation, "bytedance/seedream-4.5", "vercel-gateway"))
        .toEqual({
          status: "estimated",
          usdMin: 0.04,
          usdMax: 0.04,
          assumptions: [{ kind: "imageInputNotPriced" }],
        });
    }
    expect(calls).toEqual(["https://ai-gateway.vercel.sh/v1/models"]);
  });

  it.each(["image.generate", "image.edit.restyle", "image.edit.remove_object"])("estimates GPT Image 2 output tokens for %s without using text input rates for references", async (operation) => {
    stubGatewayFetch({
      data: [{
        id: "openai/gpt-image-2",
        type: "image",
        pricing: { input: "0.000005", output: "0.00003" },
      }],
    });

    expect(await estimateFor(operation, "openai/gpt-image-2", "vercel-gateway"))
      .toEqual({
        status: "estimated",
        usdMin: 0.05268,
        usdMax: 0.05268,
        assumptions: [
          { kind: "imageOutputTokens", value: 1756 },
          { kind: "imageInputNotPriced" },
        ],
      });
  });

  it("uses an explicit default image price instead of a language output-token price", async () => {
    stubGatewayFetch({
      data: [{
        id: "google/gemini-3-pro-image",
        type: "language",
        pricing: {
          output: "0.000012",
          image_dimension_quality_pricing: [
            { size: "4K", cost: "0.24" },
            { size: "default", cost: "0.1344" },
          ],
        },
      }],
    });

    expect(await estimateFor("image.generate", "google/gemini-3-pro-image", "vercel-gateway"))
      .toEqual({ status: "estimated", usdMin: 0.1344, usdMax: 0.1344, assumptions: [] });
  });

  it("distinguishes a missing model from an image price that is not published", async () => {
    stubGatewayFetch({ data: [] });

    expect(await estimateFor("image.generate", "nope/nope", "vercel-gateway"))
      .toEqual({ status: "unknown", reason: "model_not_found" });
  });

  it("keeps asking OpenRouter for an OpenRouter row", async () => {
    const calls = stubGatewayFetch({ data: [] });

    await estimateFor("video.generate", "google/veo-3.1", "openrouter");

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((url) => url.includes("ai-gateway.vercel.sh"))).toBe(false);
  });
});
