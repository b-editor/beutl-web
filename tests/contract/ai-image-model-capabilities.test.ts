import { beforeEach, describe, expect, it, vi } from "vitest";

const listModelEndpoints = vi.hoisted(() => vi.fn());
vi.mock("../../packages/api/src/ai/openrouter", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../packages/api/src/ai/openrouter")
  >();
  return {
    ...actual,
    createPublicOpenRouterClient: () => ({ images: { listModelEndpoints } }),
  };
});

import {
  clearAiImageModelCapabilitiesCache,
  isImageModelUsable,
  loadAiImageModelCapabilities,
  unsupportedImageRequestReason,
  type AiImageModelCapabilities,
} from "../../packages/api/src/ai/image-model-capabilities";

// The parameters the provider publishes for an endpoint. GPT Image-1 really
// does list these four ratios and nothing else.
function endpoint(parameters: Record<string, unknown>) {
  return { supportedParameters: parameters };
}

const GPT_IMAGE_1 = [
  endpoint({
    aspect_ratio: { type: "enum", values: ["1:1", "3:2", "2:3", "auto"] },
    background: { type: "enum", values: ["auto", "transparent"] },
    quality: { type: "enum", values: ["auto", "high"] },
    n: { type: "range", min: 1, max: 4 },
    input_references: { type: "range", min: 0, max: 16 },
  }),
];

function capabilities(
  overrides: Partial<AiImageModelCapabilities> = {},
): AiImageModelCapabilities {
  return {
    modelId: "openai/gpt-image-1",
    aspectRatios: ["1:1", "2:3", "3:2"],
    transparentBackground: true,
    seed: false,
    inputReferences: true,
    maxReferenceImages: 4,
    resolution: false,
    ...overrides,
  };
}

describe("what an image model accepts", () => {
  beforeEach(() => {
    listModelEndpoints.mockReset();
    clearAiImageModelCapabilitiesCache();
  });

  it("keeps only the ratios both the model and this service offer", async () => {
    listModelEndpoints.mockResolvedValue({ endpoints: GPT_IMAGE_1 });

    const entry = (
      await loadAiImageModelCapabilities(["openai/gpt-image-1"])
    ).get("openai/gpt-image-1");

    // "auto" is the provider's word for "you decide" rather than a shape this
    // service asks for, and 16:9 is one it asks for that the model refuses.
    expect(entry).toEqual(capabilities());
  });

  it("reads a background by its values rather than its presence", async () => {
    // GPT Image-2 publishes a background parameter and takes only "auto" and
    // "opaque" from it. Reading the key alone offered a transparent background
    // that the provider then refused with `background: not supported`.
    listModelEndpoints.mockResolvedValue({
      endpoints: [
        endpoint({
          aspect_ratio: { type: "enum", values: ["1:1"] },
          background: { type: "enum", values: ["auto", "opaque"] },
          resolution: { type: "enum", values: ["1K", "2K"] },
        }),
      ],
    });

    const entry = (await loadAiImageModelCapabilities(["openai/gpt-image-2"]))
      .get("openai/gpt-image-2");
    expect(entry?.transparentBackground).toBe(false);
    // Upscaling asks for 4K, which this model's sizes stop short of.
    expect(entry?.resolution).toBe(false);
  });

  it("takes no more pictures than the model publishes", async () => {
    // Grok takes three, and this service is priced for four; the smaller of the
    // two is what the screen may offer.
    listModelEndpoints.mockResolvedValue({
      endpoints: [
        endpoint({
          aspect_ratio: { type: "enum", values: ["1:1"] },
          input_references: { type: "range", min: 0, max: 3 },
        }),
      ],
    });

    const entry = (await loadAiImageModelCapabilities(["x-ai/grok"])).get("x-ai/grok");
    expect(entry?.maxReferenceImages).toBe(3);
    expect(
      unsupportedImageRequestReason(entry, { referenceImages: 4 }),
    ).toBe("referenceImages");
    expect(unsupportedImageRequestReason(entry, { referenceImages: 3 })).toBeNull();
  });

  it("takes the union of what a model's endpoints accept", async () => {
    // The router picks an endpoint that can serve the request, so a shape any
    // of them takes is a shape the model takes.
    listModelEndpoints.mockResolvedValue({
      endpoints: [
        endpoint({ aspect_ratio: { type: "enum", values: ["1:1"] } }),
        endpoint({
          aspect_ratio: { type: "enum", values: ["16:9"] },
          seed: { type: "range", min: 0, max: 1 },
        }),
      ],
    });

    const entry = (await loadAiImageModelCapabilities(["a/model"])).get("a/model");
    expect(entry?.aspectRatios).toEqual(["1:1", "16:9"]);
    expect(entry?.seed).toBe(true);
  });

  it("asks once per model and reuses the answer", async () => {
    listModelEndpoints.mockResolvedValue({ endpoints: GPT_IMAGE_1 });

    await loadAiImageModelCapabilities(["openai/gpt-image-1", "openai/gpt-image-1"]);
    await loadAiImageModelCapabilities(["openai/gpt-image-1"]);

    expect(listModelEndpoints).toHaveBeenCalledOnce();
  });

  it("imposes nothing when the provider cannot be reached", async () => {
    listModelEndpoints.mockRejectedValue(new Error("provider is down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    // An outage in the lookup must not take image generation offline.
    await expect(loadAiImageModelCapabilities(["a/model"])).resolves.toEqual(
      new Map(),
    );
    expect(
      unsupportedImageRequestReason(undefined, { aspectRatio: "16:9" }),
    ).toBeNull();
  });
});

describe("refusing an image request the model would reject", () => {
  it("names the parameter the model does not take", () => {
    const gptImage1 = capabilities();
    expect(
      unsupportedImageRequestReason(gptImage1, { aspectRatio: "16:9" }),
    ).toBe("aspectRatio");
    expect(unsupportedImageRequestReason(gptImage1, { aspectRatio: "3:2" })).toBeNull();
    expect(unsupportedImageRequestReason(gptImage1, { seed: 7 })).toBe("seed");
    expect(
      unsupportedImageRequestReason(gptImage1, { resolution: true }),
    ).toBe("resolution");
    expect(
      unsupportedImageRequestReason(
        capabilities({ transparentBackground: false }),
        { transparentBackground: true },
      ),
    ).toBe("background");
    expect(
      unsupportedImageRequestReason(
        capabilities({ inputReferences: false, maxReferenceImages: 0 }),
        { referenceImages: 1 },
      ),
    ).toBe("referenceImages");
  });

  it("lets an opaque background through a model that cannot cut one", () => {
    // The flag says the model can cut a background out; not asking it to is
    // always fine.
    expect(
      unsupportedImageRequestReason(
        capabilities({ transparentBackground: false }),
        { transparentBackground: false },
      ),
    ).toBeNull();
  });
});

describe("whether a registered image model can serve its operation", () => {
  it("rules out a model an edit cannot hand a picture to", () => {
    const noReferences = capabilities({
      inputReferences: false,
      maxReferenceImages: 0,
    });
    expect(isImageModelUsable(noReferences)).toBe(true);
    // Every edit sends the picture being edited.
    expect(isImageModelUsable(noReferences, { referenceImages: true })).toBe(false);
  });

  it("rules out a model that cannot be asked for a size when upscaling", () => {
    expect(
      isImageModelUsable(capabilities(), {
        referenceImages: true,
        resolution: true,
      }),
    ).toBe(false);
    expect(
      isImageModelUsable(capabilities({ resolution: true }), {
        referenceImages: true,
        resolution: true,
      }),
    ).toBe(true);
  });

  it("keeps a model the provider does not describe", () => {
    expect(isImageModelUsable(undefined, { referenceImages: true })).toBe(true);
  });
});
