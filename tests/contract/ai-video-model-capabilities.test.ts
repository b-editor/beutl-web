import { beforeEach, describe, expect, it, vi } from "vitest";

const listVideoModels = vi.hoisted(() => vi.fn());
vi.mock("../../packages/api/src/ai/openrouter-video", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../packages/api/src/ai/openrouter-video")
  >();
  return { ...actual, listVideoModels };
});

import {
  clearAiVideoModelCapabilitiesCache,
  isVideoModelUsable,
  loadAiVideoModelCapabilities,
  unsupportedVideoRequestReason,
  type AiVideoModelCapabilities,
} from "../../packages/api/src/ai/video-model-capabilities";

function providerModel(overrides: Record<string, unknown> = {}) {
  return {
    id: "google/veo-3.1",
    supportedResolutions: ["720p", "1080p", "4K"],
    supportedDurations: [4, 6, 8],
    supportedAspectRatios: ["16:9", "9:16"],
    supportedFrameImages: ["first_frame", "last_frame"],
    generateAudio: true,
    seed: true,
    ...overrides,
  };
}

function capabilities(
  overrides: Partial<AiVideoModelCapabilities> = {},
): AiVideoModelCapabilities {
  return {
    modelId: "google/veo-3.1",
    resolutions: ["720p", "1080p"],
    durations: [4, 6, 8],
    aspectRatios: ["16:9", "9:16"],
    generateAudio: true,
    seed: true,
    frameImages: true,
    ...overrides,
  };
}

describe("what a video model accepts", () => {
  beforeEach(() => {
    listVideoModels.mockReset();
    clearAiVideoModelCapabilitiesCache();
  });

  it("keeps only what both the model and this service offer", async () => {
    listVideoModels.mockResolvedValue([providerModel()]);

    const entry = (await loadAiVideoModelCapabilities()).get("google/veo-3.1");

    // 4K is the provider's; this service never asks for it.
    expect(entry).toEqual(capabilities());
  });

  it("treats an unstated restriction as no restriction", async () => {
    // null is the provider saying nothing about a field, which is not the same
    // as restricting it to nothing.
    listVideoModels.mockResolvedValue([
      providerModel({
        supportedResolutions: null,
        supportedDurations: null,
        supportedAspectRatios: null,
        supportedFrameImages: null,
        generateAudio: null,
        seed: null,
      }),
    ]);

    expect((await loadAiVideoModelCapabilities()).get("google/veo-3.1")).toEqual(
      capabilities(),
    );
  });

  it("asks the provider once and reuses the answer", async () => {
    listVideoModels.mockResolvedValue([providerModel()]);

    await loadAiVideoModelCapabilities();
    await loadAiVideoModelCapabilities();

    expect(listVideoModels).toHaveBeenCalledOnce();
  });

  it("imposes nothing when the provider cannot be reached", async () => {
    listVideoModels.mockRejectedValue(new Error("provider is down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    // An outage in the capability list must not take video generation offline:
    // callers read a missing entry as "no restriction known".
    await expect(loadAiVideoModelCapabilities()).resolves.toEqual(new Map());
    expect(unsupportedVideoRequestReason(undefined, {
      resolution: "1080p",
      durationSeconds: 4,
    })).toBeNull();
  });
});

describe("refusing a request the model would reject", () => {
  const request = {
    resolution: "720p",
    durationSeconds: 4,
    aspectRatio: "16:9",
    generateAudio: true,
  };

  it("accepts a request every side supports", () => {
    expect(unsupportedVideoRequestReason(capabilities(), request)).toBeNull();
  });

  it("names the parameter the model does not take", () => {
    // MiniMax H3 renders only at 2K and refuses anything under five seconds,
    // which is the shape of the failure this exists for.
    expect(
      unsupportedVideoRequestReason(capabilities({ resolutions: [] }), request),
    ).toBe("resolution");
    expect(
      unsupportedVideoRequestReason(
        capabilities({ durations: [6, 8] }),
        request,
      ),
    ).toBe("duration");
    expect(
      unsupportedVideoRequestReason(
        capabilities({ aspectRatios: ["9:16"] }),
        request,
      ),
    ).toBe("aspectRatio");
    expect(
      unsupportedVideoRequestReason(
        capabilities({ generateAudio: false }),
        request,
      ),
    ).toBe("generateAudio");
    expect(
      unsupportedVideoRequestReason(capabilities({ seed: false }), {
        ...request,
        seed: 7,
      }),
    ).toBe("seed");
    expect(
      unsupportedVideoRequestReason(capabilities({ frameImages: false }), {
        ...request,
        frameImages: true,
      }),
    ).toBe("frameImages");
  });

  it("lets a silent clip through a model that cannot speak", () => {
    // The flag says the model can produce audio, so asking it not to is always
    // fine; only asking for audio it cannot make is a refusal.
    expect(
      unsupportedVideoRequestReason(capabilities({ generateAudio: false }), {
        ...request,
        generateAudio: false,
      }),
    ).toBeNull();
  });

  it("says nothing about a model the provider does not list", () => {
    // The catalog decides which models exist. A stale list must not take a
    // working model offline.
    expect(unsupportedVideoRequestReason(undefined, request)).toBeNull();
  });
});

describe("whether a registered model can serve anything", () => {
  it("rejects a model that shares no parameter with this service", () => {
    expect(isVideoModelUsable(capabilities({ resolutions: [] }))).toBe(false);
    expect(isVideoModelUsable(capabilities({ durations: [] }))).toBe(false);
    expect(isVideoModelUsable(capabilities({ aspectRatios: [] }))).toBe(false);
  });

  it("keeps a model with one workable combination", () => {
    expect(
      isVideoModelUsable(
        capabilities({ resolutions: ["720p"], durations: [4] }),
      ),
    ).toBe(true);
  });

  it("keeps a model the provider does not list", () => {
    expect(isVideoModelUsable(undefined)).toBe(true);
  });
});
