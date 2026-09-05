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
// The envelopes the provider sends around a price. Only the pricing matters
// here; the rest is what a real reply carries, and the client validates it.
function modelPayload(id: string, pricing: Record<string, string>) {
  return {
    data: {
      id,
      canonical_slug: id,
      name: id,
      created: 1,
      context_length: 128000,
      architecture: {
        modality: "text->text",
        input_modalities: ["text"],
        output_modalities: ["text"],
        tokenizer: "GPT",
        instruct_type: null,
      },
      links: { details: `/api/v1/models/${id}/endpoints` },
      per_request_limits: null,
      default_parameters: {},
      supported_parameters: [],
      supported_voices: null,
      top_provider: {
        context_length: 128000,
        max_completion_tokens: 32768,
        is_moderated: false,
      },
      pricing,
    },
  };
}

function imageEndpoints(
  id: string,
  pricing: { billable: string; unit: string; cost_usd: number }[],
) {
  const provider = id.split("/")[0];
  return {
    id,
    endpoints: [
      {
        provider_name: provider,
        provider_slug: provider,
        provider_tag: provider,
        supported_parameters: {},
        allowed_passthrough_parameters: [],
        supports_streaming: false,
        pricing,
      },
    ],
  };
}

const GPT_IMAGE_ENDPOINTS = imageEndpoints("openai/gpt-image-1", [
  { billable: "input_image", unit: "token", cost_usd: 0.00001 },
  { billable: "input_text", unit: "token", cost_usd: 0.000005 },
  { billable: "output_image", unit: "token", cost_usd: 0.00004 },
]);

const SEEDREAM_ENDPOINTS = imageEndpoints("bytedance-seed/seedream-4.5", [
  { billable: "output_image", unit: "image", cost_usd: 0.04 },
]);

const WHISPER_MODEL = modelPayload("openai/whisper-large-v3-turbo", {
  prompt: "0.00000333",
  completion: "0",
});

const GPT_4_1_MINI_MODEL = modelPayload("openai/gpt-4.1-mini", {
  prompt: "0.0000004",
  completion: "0.0000016",
});

const VIDEO_MODELS = {
  data: [
    {
      id: "google/veo-3.1",
      canonical_slug: "google/veo-3.1",
      name: "Google: Veo 3.1",
      created: 1,
      supported_resolutions: ["720p", "1080p"],
      supported_durations: [4, 6, 8],
      supported_aspect_ratios: ["16:9", "9:16"],
      supported_frame_images: ["first_frame"],
      supported_sizes: null,
      generate_audio: true,
      seed: true,
      allowed_passthrough_parameters: [],
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
      ? jsonResponse({ error: { code: 404, message: "Resource not found" } }, 404)
      : jsonResponse(body);
  },
) {
  const mock = vi.fn(async (input: RequestInfo | URL) =>
    handler(
      typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : String(input),
    ),
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

    // 1,056 output tokens at $0.00004 reproduces OpenAI's published $0.042, plus
    // the pictures a generation may be guided by — AI_MAX_IMAGE_REFERENCES of
    // them at 1,056 input tokens each. The estimate assumes the most a caller
    // can send, because that is what the price has to cover; understating the
    // cost is the direction that misleads.
    const generate = byOperation.get("image.generate")?.estimate;
    expect(generate?.status).toBe("estimated");
    if (generate?.status === "estimated") {
      expect(generate.usdMin).toBeCloseTo(0.08448, 8);
      expect(generate.usdMax).toBeCloseTo(0.08448, 8);
    }
    const edit = byOperation.get("image.edit.remove_background")?.estimate;
    expect(edit?.status).toBe("estimated");
    if (edit?.status === "estimated") {
      // An edit sends one source image rather than generation's maximum four.
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

    const urls = mock.mock.calls.map((call) => (call[0] as Request).url);
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
        ? jsonResponse(
            modelPayload("groq/some-unlisted-transcriber", {
              prompt: "0.04",
              completion: "0",
            }),
          )
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
        ? jsonResponse(
            imageEndpoints("openai/gpt-image-1", [
              { billable: "output_image", unit: "seconds", cost_usd: 0.05 },
            ]),
          )
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

  it("prices an audio-incapable video model with its silent SKU", async () => {
    stubFetch((url) =>
      url.endsWith("/videos/models")
        ? jsonResponse({
            data: [{
              ...VIDEO_MODELS.data[0],
              id: "vendor/silent-video",
              canonical_slug: "vendor/silent-video",
              name: "Silent video",
              generate_audio: false,
              pricing_skus: { duration_seconds_without_audio: "0.20" },
            }],
          })
        : jsonResponse(routeFor(url) ?? {}),
    );

    const result = await loadAiCostEstimates({
      modelsOf: (operation) =>
        operation === "video.generate" ? ["vendor/silent-video"] : [],
    });

    expect(result.entries[0]?.estimate).toMatchObject({
      status: "estimated",
      usdMin: 0.2,
    });
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

  // A video token is a fixed slice of picture, so a per-token rate becomes a
  // per-second cost once the resolution is known. These are the rates
  // /videos/models publishes for the ByteDance models, and the expected figures
  // are the per-second prices OpenRouter publishes for them: the conversion is
  // checked against the provider rather than inferred, because a wrong factor
  // here would be believed.
  it.each([
    ["bytedance/seedance-2.5", "0.0000107", "720p", 0.23112],
    ["bytedance/seedance-2.5", "0.0000107", "1080p", 0.52002],
    ["bytedance/seedance-2.0", "0.000007", "720p", 0.1512],
    ["bytedance/seedance-1-5-pro", "0.0000024", "720p", 0.05184],
    ["bytedance/seedance-1-5-pro", "0.0000024", "1080p", 0.11664],
  ])(
    "costs %s by the second from its per-token rate at %s",
    (_model, rate, resolution, expected) => {
      const estimate = estimateVideoCost({
        pricingSkus: { video_tokens: rate, video_tokens_without_audio: rate },
        resolution,
        withAudio: true,
      });

      expect(estimate.status).toBe("estimated");
      if (estimate.status !== "estimated") return;
      expect(estimate.usdMin).toBeCloseTo(expected, 8);
    },
  );

  it("prefers a resolution-specific token SKU", () => {
    // seedance-2.0 prices 1080p above its base rate.
    const estimate = estimateVideoCost({
      pricingSkus: {
        video_tokens: "0.000007",
        video_tokens_1080p: "0.0000077",
        video_tokens_4k: "0.000004",
      },
      resolution: "1080p",
      withAudio: true,
    });

    expect(estimate.status).toBe("estimated");
    if (estimate.status !== "estimated") return;
    expect(estimate.usdMin).toBeCloseTo(0.37422, 8);
  });

  it("says what a second was taken to be", () => {
    const estimate = estimateVideoCost({
      pricingSkus: { video_tokens: "0.0000107" },
      resolution: "720p",
      withAudio: true,
    });

    // The figure only means anything alongside the frame size and rate it
    // assumed, so the panel is given both to print.
    expect(estimate).toMatchObject({
      assumptions: expect.arrayContaining([
        { kind: "videoTokens", tokensPerSecond: 21600, resolution: "720p" },
      ]),
    });
  });

  it("reports a token rate as unknown at a resolution it cannot size", () => {
    expect(
      estimateVideoCost({
        pricingSkus: { video_tokens: "0.0000107" },
        resolution: "360p",
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
