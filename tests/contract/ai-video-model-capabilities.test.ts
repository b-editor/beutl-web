import { beforeEach, describe, expect, it, vi } from "vitest";

const listVideoModels = vi.hoisted(() => vi.fn());
vi.mock("../../packages/api/src/ai/openrouter-video", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../packages/api/src/ai/openrouter-video")
  >();
  return { ...actual, listVideoModels };
});

// Every registered provider is asked, and the Gateway's list is a real HTTP
// GET. Left alone it would put the network in the middle of these assertions.
const listGatewayVideoModels = vi.hoisted(() => vi.fn());
vi.mock(
  "../../packages/api/src/ai/providers/vercel-gateway/models",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("../../packages/api/src/ai/providers/vercel-gateway/models")
    >();
    return { ...actual, listGatewayVideoModels };
  },
);

import {
  AI_MAX_VIDEO_INPUT_REFERENCES,
  AI_VIDEO_ASPECT_RATIOS,
  AI_VIDEO_DURATIONS_SECONDS,
  AI_VIDEO_RESOLUTIONS,
  MAX_AI_PROMPT_LENGTH,
  MAX_AI_SOURCE_VIDEO_UPLOAD_BYTES,
  MAX_AI_VIDEO_FRAME_UPLOAD_BYTES,
  MAX_AI_VIDEO_INPUT_AUDIO_BYTES,
  MAX_AI_VIDEO_INPUT_VIDEOS_TOTAL_BYTES,
} from "@beutl/core";
import {
  clearAiVideoModelCapabilitiesCache,
  isVideoModelUsable,
  loadAiVideoModelCapabilities,
  unsupportedVideoRequestReason,
  unusableVideoModelsFor,
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
    firstFrame: true,
    lastFrame: true,
    promptToVideo: true,
    // Reference pictures are the exception to "unstated means unrestricted":
    // a model that cannot take them drops them with a warning, so nothing is
    // offered unless the provider says so.
    referenceToVideo: false,
    // The three modes that work from a video this service already holds are
    // off for the same reason: nothing is offered on a guess.
    videoEditing: false,
    videoExtension: false,
    motionControl: false,
    // Nothing published, so the service's own ceilings stand.
    maxInputReferences: AI_MAX_VIDEO_INPUT_REFERENCES,
    maxReferenceBytes: MAX_AI_VIDEO_FRAME_UPLOAD_BYTES,
    maxSourceVideoBytes: MAX_AI_SOURCE_VIDEO_UPLOAD_BYTES,
    minSourceVideoSeconds: null,
    maxSourceVideoSeconds: null,
    maxPromptCharacters: MAX_AI_PROMPT_LENGTH,
    // Nothing published, so neither kind is offered.
    maxVideoReferences: 0,
    maxVideoReferenceBytes: 0,
    maxAudioReferences: 0,
    maxAudioReferenceBytes: 0,
    ...overrides,
  };
}

describe("what a video model accepts", () => {
  beforeEach(() => {
    listVideoModels.mockReset();
    listGatewayVideoModels.mockReset();
    listGatewayVideoModels.mockResolvedValue([]);
    clearAiVideoModelCapabilitiesCache();
  });

  it("keeps only what both the model and this service offer", async () => {
    listVideoModels.mockResolvedValue([providerModel()]);

    const entry = (await loadAiVideoModelCapabilities()).get("google/veo-3.1");

    // 4K is the provider's; this service never asks for it.
    expect(entry).toEqual(capabilities());
  });

  it("offers as much as the model says it takes", async () => {
    // MiniMax H3 takes nine pictures and a fifty-megabyte source video.
    // Holding every model to one service-wide number threw that away.
    // Only the Gateway publishes allowances; the OpenRouter adapter states
    // none, which is why this goes through the Gateway's list.
    listVideoModels.mockResolvedValue([]);
    listGatewayVideoModels.mockResolvedValue([
      providerModel({
        id: "minimax/minimax-h3",
        inputLimits: {
          maxImages: 9,
          maxImageBytes: 30 * 1024 * 1024,
          maxVideos: 3,
          maxVideoBytes: 50 * 1024 * 1024,
          minVideoDurationSeconds: 2,
          maxVideoDurationSeconds: 15,
          maxPromptCharacters: 2500,
          maxTotalInputs: 5,
        },
      }),
    ]);

    const entry = (await loadAiVideoModelCapabilities()).get(
      "minimax/minimax-h3",
    );

    expect(entry?.maxInputReferences).toBe(9);
    // The model's thirty megabytes is more than this service serves, so the
    // service's own figure stands.
    expect(entry?.maxReferenceBytes).toBe(MAX_AI_VIDEO_FRAME_UPLOAD_BYTES);
    expect(entry?.maxSourceVideoBytes).toBe(
      Math.min(50 * 1024 * 1024, MAX_AI_SOURCE_VIDEO_UPLOAD_BYTES),
    );
    expect(entry?.minSourceVideoSeconds).toBe(2);
    expect(entry?.maxSourceVideoSeconds).toBe(15);
    // Below this service's own limit, and that is the direction that matters:
    // a prompt the screen accepts is one the model refuses.
    expect(entry?.maxPromptCharacters).toBe(2500);
  });

  it("never offers more than this service can carry", async () => {
    // Seedance 2.5 publishes thirty pictures and a two-hundred-megabyte clip.
    // Offering them would put both well past a 128 MiB Worker's budget.
    listVideoModels.mockResolvedValue([]);
    listGatewayVideoModels.mockResolvedValue([
      providerModel({
        id: "bytedance/seedance-2.5",
        inputLimits: {
          maxImages: 30,
          maxImageBytes: 30 * 1024 * 1024,
          maxVideos: 10,
          maxVideoBytes: 200 * 1024 * 1024,
          minVideoDurationSeconds: 2,
          maxVideoDurationSeconds: 30,
          maxPromptCharacters: 20_000,
          maxTotalInputs: 50,
        },
      }),
    ]);

    const entry = (await loadAiVideoModelCapabilities()).get(
      "bytedance/seedance-2.5",
    );

    expect(entry?.maxInputReferences).toBe(AI_MAX_VIDEO_INPUT_REFERENCES);
    expect(entry?.maxReferenceBytes).toBe(MAX_AI_VIDEO_FRAME_UPLOAD_BYTES);
    expect(entry?.maxSourceVideoBytes).toBe(MAX_AI_SOURCE_VIDEO_UPLOAD_BYTES);
    expect(entry?.maxPromptCharacters).toBe(MAX_AI_PROMPT_LENGTH);
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

    // Everything on offer, which for the lengths is every whole second the
    // server considers rather than the three a model happens to publish.
    expect((await loadAiVideoModelCapabilities()).get("google/veo-3.1")).toEqual(
      capabilities({
        resolutions: [...AI_VIDEO_RESOLUTIONS],
        durations: [...AI_VIDEO_DURATIONS_SECONDS],
        aspectRatios: [...AI_VIDEO_ASPECT_RATIOS],
      }),
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
    listGatewayVideoModels.mockRejectedValue(new Error("gateway is down"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const warningLog = vi.spyOn(console, "warn").mockImplementation(() => {});

    // An outage in the capability list must not take video generation offline:
    // callers read a missing entry as "no restriction known".
    await expect(loadAiVideoModelCapabilities()).resolves.toEqual(new Map());
    expect(unsupportedVideoRequestReason(undefined, {
      resolution: "1080p",
      durationSeconds: 4,
    })).toBeNull();
    expect(errorLog).not.toHaveBeenCalled();
    // The warning names which provider went quiet; with several registered,
    // "the video model list failed" would not say whose.
    expect(warningLog).toHaveBeenCalledWith(
      "Failed to read openrouter video model capabilities",
      { message: "provider is down" },
    );
    // One provider going quiet must not be reported as another's.
    expect(warningLog).toHaveBeenCalledWith(
      "Failed to read vercel-gateway video model capabilities",
      { message: "gateway is down" },
    );
    errorLog.mockRestore();
    warningLog.mockRestore();
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
      unsupportedVideoRequestReason(capabilities({ firstFrame: false }), {
        ...request,
        firstFrame: true,
      }),
    ).toBe("firstFrame");
    // 開始フレームだけを取るモデルに終了フレームを渡したときに気づけること。
    // ひとまとめのフラグではここが見分けられなかった。
    expect(
      unsupportedVideoRequestReason(capabilities({ lastFrame: false }), {
        ...request,
        firstFrame: true,
        lastFrame: true,
      }),
    ).toBe("lastFrame");
    expect(
      unsupportedVideoRequestReason(capabilities({ lastFrame: false }), {
        ...request,
        firstFrame: true,
      }),
    ).toBeNull();
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

  it("refuses reference pictures on a model that does not take them", () => {
    // Unlike every other field here, an unstated answer is "no". A provider
    // handed references by a model that cannot use them drops them with a
    // warning and bills for a video of something else.
    expect(
      unsupportedVideoRequestReason(capabilities(), {
        ...request,
        inputReferences: true,
      }),
    ).toBe("inputReferences");
    expect(
      unsupportedVideoRequestReason(
        capabilities({ referenceToVideo: true }),
        { ...request, inputReferences: true },
      ),
    ).toBeNull();
  });

  it("says nothing about a model the provider does not list", () => {
    // The catalog decides which models exist. A stale list must not take a
    // working model offline.
    expect(unsupportedVideoRequestReason(undefined, request)).toBeNull();
  });
});

describe("what a model is actually offered", () => {
  beforeEach(() => {
    clearAiVideoModelCapabilitiesCache();
    listVideoModels.mockReset();
    listGatewayVideoModels.mockReset();
    listGatewayVideoModels.mockResolvedValue([]);
  });

  it("offers no sound, whatever the catalog says it takes", async () => {
    // Verified against the live Gateway on 2026-09-20 with
    // alibaba/wan-v2.6-t2v: a silent WAV and a deliberately corrupt one
    // declared as audio/wav both completed, with no warning either time. Read
    // audio would have failed the second. Until the provider consumes it,
    // offering the field would sell a control that does nothing.
    listVideoModels.mockResolvedValue([]);
    listGatewayVideoModels.mockResolvedValue([
      providerModel({
        id: "alibaba/wan-v2.6-t2v",
        inputLimits: {
          maxImages: 5,
          maxImageBytes: 20 * 1024 * 1024,
          maxVideos: 3,
          maxVideoBytes: 100 * 1024 * 1024,
          minVideoDurationSeconds: 1,
          maxVideoDurationSeconds: 30,
          maxAudio: 1,
          maxAudioBytes: 15 * 1024 * 1024,
          minAudioDurationSeconds: 3,
          maxAudioDurationSeconds: 30,
          maxPromptCharacters: 1500,
          maxTotalInputs: 5,
        },
      }),
    ]);

    const entry = (await loadAiVideoModelCapabilities()).get("alibaba/wan-v2.6-t2v");

    expect(entry?.maxAudioReferences).toBe(0);
    expect(entry?.maxAudioReferenceBytes).toBe(0);
    // Clips are offered, and were confirmed to work: three references of a
    // hosted clip completed on alibaba/wan-v2.6-r2v the same day.
    expect(entry?.maxVideoReferences).toBe(3);
  });
});

describe("how many references of each kind a model takes", () => {
  const h3 = capabilities({
    modelId: "minimax/minimax-h3",
    referenceToVideo: true,
    maxInputReferences: 9,
    maxVideoReferences: 3,
    maxVideoReferenceBytes: 50 * 1024 * 1024,
    maxAudioReferences: 1,
    maxAudioReferenceBytes: 15 * 1024 * 1024,
  });
  const request = {
    resolution: "720p",
    durationSeconds: 4,
    aspectRatio: "16:9",
  };

  it("accepts the nine pictures and three clips it publishes", () => {
    expect(
      unsupportedVideoRequestReason(h3, {
        ...request,
        inputReferences: 9,
        videoReferences: 3,
        audioReferences: 1,
      }),
    ).toBeNull();
  });

  it("refuses a kind the model takes none of", () => {
    const veo = capabilities({
      referenceToVideo: true,
      maxInputReferences: 3,
      maxVideoReferences: 1,
      maxAudioReferences: 0,
    });

    expect(
      unsupportedVideoRequestReason(veo, { ...request, audioReferences: 1 }),
    ).toBe("audioReferenceCount");
    expect(
      unsupportedVideoRequestReason(veo, { ...request, videoReferences: 2 }),
    ).toBe("videoReferenceCount");
    expect(
      unsupportedVideoRequestReason(veo, { ...request, inputReferences: 4 }),
    ).toBe("inputReferenceCount");
  });

  it("still refuses every kind on a model that takes no references", () => {
    const plain = capabilities({ referenceToVideo: false });

    for (const carried of [
      { inputReferences: 1 },
      { videoReferences: 1 },
      { audioReferences: 1 },
    ]) {
      expect(
        unsupportedVideoRequestReason(plain, { ...request, ...carried }),
        JSON.stringify(carried),
      ).toBe("inputReferences");
    }
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

  it("keeps a model that renders only at 2K", () => {
    // MiniMax H3 takes nothing but 2K and nothing shorter than five seconds.
    // A fixed menu of 720p/1080p and 4/6/8 seconds left it registered and
    // unusable: every request the screen could build was refused.
    const hailuo = capabilities({
      modelId: "minimax/hailuo-3",
      resolutions: ["2K"],
      durations: [5, 6, 7, 8, 9, 10],
      seed: false,
    });

    expect(isVideoModelUsable(hailuo)).toBe(true);
    expect(
      unsupportedVideoRequestReason(hailuo, {
        resolution: "2K",
        durationSeconds: 6,
        aspectRatio: "16:9",
        generateAudio: true,
      }),
    ).toBeNull();
  });

  it("keeps a model the provider does not list", () => {
    expect(isVideoModelUsable(undefined)).toBe(true);
  });
});

describe("which registered models an operation cannot use", () => {
  // Kling's motion-control models publish motion-control and nothing else:
  // no text-to-video, and so no shape a generation could be built from.
  const motionOnly = capabilities({
    modelId: "klingai/kling-v3.0-motion-control",
    promptToVideo: false,
    motionControl: true,
    resolutions: ["720p", "1080p"],
    aspectRatios: ["16:9", "9:16", "1:1"],
    durations: [5, 10],
  });
  const known = new Map([[motionOnly.modelId, motionOnly]]);

  it("keeps the motion model for the operation that needs it", () => {
    // The regression this exists for: the console asked the generation
    // question about every registered row, so the one model video.motion can
    // run on was reported as certain to fail and told to be replaced.
    expect(
      unusableVideoModelsFor("video.motion", [motionOnly.modelId], known),
    ).toEqual(new Set());
  });

  it("still refuses it for a plain generation", () => {
    expect(
      unusableVideoModelsFor("video.generate", [motionOnly.modelId], known),
    ).toEqual(new Set([motionOnly.modelId]));
  });

  it("asks each source-video mode about its own capability", () => {
    const grok = capabilities({
      modelId: "spacexai/grok-imagine-video",
      videoEditing: true,
      videoExtension: true,
      motionControl: false,
    });
    const listed = new Map([[grok.modelId, grok]]);

    expect(unusableVideoModelsFor("video.edit", [grok.modelId], listed)).toEqual(
      new Set(),
    );
    expect(
      unusableVideoModelsFor("video.extend", [grok.modelId], listed),
    ).toEqual(new Set());
    expect(
      unusableVideoModelsFor("video.motion", [grok.modelId], listed),
    ).toEqual(new Set([grok.modelId]));
  });

  it("leaves alone a model the provider does not list", () => {
    expect(
      unusableVideoModelsFor("video.generate", ["vendor/unlisted"], new Map()),
    ).toEqual(new Set());
  });
});
