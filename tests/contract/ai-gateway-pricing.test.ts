import { afterEach, describe, expect, it, vi } from "vitest";
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
        usdMin: 1056 * 0.00003,
        usdMax: 1056 * 0.00003,
        assumptions: [
          { kind: "imageOutputTokens", value: 1056 },
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
