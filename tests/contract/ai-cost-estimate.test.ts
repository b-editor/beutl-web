import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAiModelPricingCache,
  estimateTranslationCost,
  estimateVideoCost,
  loadAiCostEstimates,
} from "@beutl/api";
import { AI_OPERATIONS } from "@beutl/core";

// Response bodies below mirror what the public OpenRouter endpoints actually
// return for the built-in models.
const GPT_IMAGE_ENDPOINTS = {
  id: "openai/gpt-image-1",
  endpoints: [
    {
      provider_slug: "openai",
      pricing: [
        { billable: "input_image", unit: "token", cost_usd: 0.00001 },
        { billable: "input_text", unit: "token", cost_usd: 0.000005 },
        { billable: "output_image", unit: "token", cost_usd: 0.00004 },
      ],
    },
  ],
};

const SEEDREAM_ENDPOINTS = {
  id: "bytedance-seed/seedream-4.5",
  endpoints: [
    {
      provider_slug: "seed",
      pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.04 }],
    },
  ],
};

const WHISPER_MODEL = {
  data: {
    id: "openai/whisper-large-v3-turbo",
    pricing: { prompt: "0.00000333", completion: "0" },
  },
};

const GPT_4_1_MINI_MODEL = {
  data: {
    id: "openai/gpt-4.1-mini",
    pricing: { prompt: "0.0000004", completion: "0.0000016" },
  },
};

const VIDEO_MODELS = {
  data: [
    {
      id: "google/veo-3.1",
      pricing_skus: {
        duration_seconds_with_audio: "0.40",
        duration_seconds_without_audio: "0.20",
        duration_seconds_with_audio_4k: "0.60",
        duration_seconds_without_audio_4k: "0.40",
      },
    },
  ],
};

const DEFAULT_MODELS: Record<string, string> = {
  "image.generate": "openai/gpt-image-1",
  "image.edit.remove_background": "openai/gpt-image-1",
  "image.edit.upscale": "bytedance-seed/seedream-4.5",
  "image.edit.restyle": "openai/gpt-image-1",
  "image.edit.remove_object": "openai/gpt-image-1",
  "image.edit.outpaint": "openai/gpt-image-1",
  "audio.transcribe": "openai/whisper-large-v3-turbo",
  "subtitle.translate": "openai/gpt-4.1-mini",
  "video.generate": "google/veo-3.1",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function routeFor(url: string): unknown | undefined {
  if (url.includes("/images/models/openai/gpt-image-1/endpoints")) {
    return GPT_IMAGE_ENDPOINTS;
  }
  if (url.includes("/images/models/bytedance-seed/seedream-4.5/endpoints")) {
    return SEEDREAM_ENDPOINTS;
  }
  if (url.includes("/model/openai/whisper-large-v3-turbo")) {
    return WHISPER_MODEL;
  }
  if (url.includes("/model/openai/gpt-4.1-mini")) {
    return GPT_4_1_MINI_MODEL;
  }
  if (url.endsWith("/videos/models")) {
    return VIDEO_MODELS;
  }
  return undefined;
}

function stubFetch(
  handler: (url: string) => Response | Promise<Response> = (url) => {
    const body = routeFor(url);
    return body === undefined
      ? jsonResponse({ error: "not found" }, 404)
      : jsonResponse(body);
  },
) {
  const mock = vi.fn(async (input: RequestInfo | URL) =>
    handler(typeof input === "string" ? input : String(input)),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

async function estimatesByOperation(force = false) {
  const result = await loadAiCostEstimates({
    modelsOf: (operation) => [DEFAULT_MODELS[operation]],
    force,
  });
  return new Map(result.entries.map((entry) => [entry.operation, entry]));
}

describe("AI provider cost estimates", () => {
  beforeEach(() => {
    clearAiModelPricingCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearAiModelPricingCache();
  });

  it("estimates every billable operation with the built-in models", async () => {
    stubFetch();
    const byOperation = await estimatesByOperation();

    expect([...byOperation.keys()].sort()).toEqual([...AI_OPERATIONS].sort());

    // 1,056 output tokens at $0.00004 reproduces OpenAI's published $0.042,
    // plus the one reference image a generation may be guided by: image.generate
    // and image.edit.* are costed alike because they send the same input at the
    // same price, and understating the cost is the direction that misleads.
    const generate = byOperation.get("image.generate")?.estimate;
    expect(generate?.status).toBe("estimated");
    if (generate?.status === "estimated") {
      expect(generate.usdMin).toBeCloseTo(0.0528, 8);
      expect(generate.usdMax).toBeCloseTo(0.0528, 8);
    }
    const edit = byOperation.get("image.edit.remove_background")?.estimate;
    expect(edit?.status).toBe("estimated");
    if (edit?.status === "estimated") {
      expect(edit.usdMin).toBeCloseTo(0.0528, 8);
    }
    // Priced per image rather than per token, so no assumption is needed.
    expect(byOperation.get("image.edit.upscale")?.estimate).toMatchObject({
      status: "estimated",
      usdMin: 0.04,
      usdMax: 0.04,
    });
    const transcribe = byOperation.get("audio.transcribe")?.estimate;
    expect(transcribe?.status).toBe("estimated");
    if (transcribe?.status === "estimated") {
      expect(transcribe.usdMin).toBeCloseTo(0.0001998, 10);
    }
    // Latin text and CJK differ about fourfold, carried as the range.
    const translate = byOperation.get("subtitle.translate")?.estimate;
    expect(translate?.status).toBe("estimated");
    if (translate?.status === "estimated") {
      expect(translate.usdMin).toBeCloseTo(0.0005, 6);
      expect(translate.usdMax).toBeCloseTo(0.002, 6);
    }
    expect(byOperation.get("video.generate")?.estimate).toMatchObject({
      status: "estimated",
      usdMin: 0.4,
    });
  });

  it("reads prices from the per-modality endpoints, not the model list", async () => {
    const mock = stubFetch();
    await estimatesByOperation();

    const urls = mock.mock.calls.map((call) => String(call[0]));
    // The bulk model list is 800 KB and reports zero for video, so it is never
    // used for this.
    expect(urls.some((url) => url.includes("output_modalities"))).toBe(false);
    expect(
      urls.some((url) =>
        url.includes("/images/models/openai/gpt-image-1/endpoints"),
      ),
    ).toBe(true);
    expect(urls.some((url) => url.endsWith("/videos/models"))).toBe(true);
    // Five operations share gpt-image-1, and one lookup covers all of them.
    expect(urls.length).toBe(5);
  });

  it("sends no credentials, because the price endpoints are public", async () => {
    const mock = stubFetch();
    await estimatesByOperation();

    for (const call of mock.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
    }
  });

  it("reuses a cached price list until it is forced to refetch", async () => {
    const mock = stubFetch();
    await estimatesByOperation();
    const firstCallCount = mock.mock.calls.length;

    await estimatesByOperation();
    expect(mock.mock.calls.length).toBe(firstCallCount);

    await estimatesByOperation(true);
    expect(mock.mock.calls.length).toBe(firstCallCount * 2);
  });

  it.each([
    [404, "model_not_found"],
    [500, "provider_unavailable"],
  ])("reports status %i as %s", async (status, reason) => {
    stubFetch(() => jsonResponse({ error: "nope" }, status));
    const byOperation = await estimatesByOperation();

    expect(byOperation.get("image.generate")?.estimate).toEqual({
      status: "unknown",
      reason,
    });
  });

  it("reports an unreadable body as unknown rather than free", async () => {
    stubFetch((url) =>
      url.includes("/images/models/")
        ? jsonResponse({ endpoints: "not an array" })
        : jsonResponse(routeFor(url) ?? {}),
    );
    const byOperation = await estimatesByOperation();

    expect(byOperation.get("image.generate")?.estimate).toEqual({
      status: "unknown",
      reason: "invalid_response",
    });
  });

  it("refuses to guess the unit of a transcription price", async () => {
    stubFetch((url) =>
      url.includes("/model/")
        ? jsonResponse({
            data: { pricing: { prompt: "0.04", completion: "0" } },
          })
        : jsonResponse(routeFor(url) ?? {}),
    );
    const byOperation = await loadAiCostEstimates({
      modelsOf: (operation) => [
        operation === "audio.transcribe"
          ? "groq/some-unlisted-transcriber"
          : DEFAULT_MODELS[operation],
      ],
    }).then(
      (result) => new Map(result.entries.map((e) => [e.operation, e])),
    );

    // The same figure means per-second for one provider and per-hour for
    // another; guessing would be wrong by orders of magnitude.
    expect(byOperation.get("audio.transcribe")?.estimate).toEqual({
      status: "unknown",
      reason: "unknown_stt_pricing_unit",
    });
  });

  it("treats an unrecognized image unit as unknown", async () => {
    stubFetch((url) =>
      url.includes("/images/models/")
        ? jsonResponse({
            endpoints: [
              {
                pricing: [
                  { billable: "output_image", unit: "seconds", cost_usd: 0.05 },
                ],
              },
            ],
          })
        : jsonResponse(routeFor(url) ?? {}),
    );
    const byOperation = await estimatesByOperation();

    expect(byOperation.get("image.generate")?.estimate).toEqual({
      status: "unknown",
      reason: "unsupported_pricing_shape",
    });
  });

  it("keeps one failing lookup from hiding the others", async () => {
    stubFetch((url) =>
      url.endsWith("/videos/models")
        ? jsonResponse({ error: "down" }, 503)
        : jsonResponse(routeFor(url) ?? {}),
    );
    const byOperation = await estimatesByOperation();

    expect(byOperation.get("video.generate")?.estimate.status).toBe("unknown");
    expect(byOperation.get("image.generate")?.estimate.status).toBe("estimated");
  });
});

describe("video SKU resolution", () => {
  it("falls back to the base SKU when the resolution has none", () => {
    // veo-3.1 publishes no 720p SKU, so the base key has to be used.
    expect(
      estimateVideoCost({
        pricingSkus: VIDEO_MODELS.data[0].pricing_skus,
        resolution: "720p",
        withAudio: true,
      }),
    ).toMatchObject({ status: "estimated", usdMin: 0.4 });
  });

  it("prefers an exact resolution match", () => {
    expect(
      estimateVideoCost({
        pricingSkus: {
          duration_seconds_with_audio: "0.40",
          duration_seconds_with_audio_720p: "0.10",
        },
        resolution: "720p",
        withAudio: true,
      }),
    ).toMatchObject({ usdMin: 0.1 });
  });

  it("matches a resolution that is not the final segment of the key", () => {
    // "_720p_with_audio" names the resolution in the middle. Scoring only the
    // tail made both keys look resolution-agnostic, and the dearer-of-equals
    // tie-break then charged the 1080p rate against a 720p request.
    const pricingSkus = {
      duration_seconds_720p_with_audio: "0.15",
      duration_seconds_1080p_with_audio: "0.40",
    };

    expect(
      estimateVideoCost({ pricingSkus, resolution: "720p", withAudio: true }),
    ).toMatchObject({ usdMin: 0.15 });
    expect(
      estimateVideoCost({ pricingSkus, resolution: "1080p", withAudio: true }),
    ).toMatchObject({ usdMin: 0.4 });
  });

  it("converts a cents-denominated SKU", () => {
    expect(
      estimateVideoCost({
        pricingSkus: { cents_per_second_output: "12" },
        resolution: "720p",
        withAudio: true,
      }),
    ).toMatchObject({ usdMin: 0.12 });
  });

  it("ignores SKUs for requests this app never makes", () => {
    expect(
      estimateVideoCost({
        pricingSkus: {
          cents_per_second_video_continuation_720p: "5",
          video_tokens_with_video_input: "9",
        },
        resolution: "720p",
        withAudio: true,
      }),
    ).toEqual({ status: "unknown", reason: "unsupported_pricing_shape" });
  });

  it("reports token-denominated video pricing as unknown", () => {
    expect(
      estimateVideoCost({
        pricingSkus: { video_tokens: "1500" },
        resolution: "720p",
        withAudio: true,
      }),
    ).toEqual({ status: "unknown", reason: "unsupported_pricing_shape" });
  });
});

describe("translation cost", () => {
  // loadModelPricing reads a missing completion rate as zero, and a translation
  // produces about as many tokens as it consumes. A figure built on the input
  // side alone is roughly half the real cost, and it is what the operator sets
  // the unit price against, so it has to read as unknown rather than as cheap.
  it("reports an unknown cost when the model publishes no completion rate", () => {
    expect(
      estimateTranslationCost({ promptPriceUsd: 0.0000004, completionPriceUsd: 0 }),
    ).toEqual({ status: "unknown", reason: "zero_price_reported" });
  });

  it("estimates once both rates are known", () => {
    expect(
      estimateTranslationCost({
        promptPriceUsd: 0.0000004,
        completionPriceUsd: 0.0000016,
      }),
    ).toMatchObject({ status: "estimated" });
  });
});
