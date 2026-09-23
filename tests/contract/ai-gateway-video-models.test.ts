import { describe, expect, it } from "vitest";
import {
  listGatewayVideoModels,
  toVideoModelDescriptor,
} from "../../packages/api/src/ai/providers/vercel-gateway/models";
import { AiProviderError } from "../../packages/api/src/ai/providers/errors";
import { UNSTATED_VIDEO_INPUT_LIMITS } from "../../packages/api/src/ai/providers/types";

// The capability blocks below are copied from the live GET /v1/models response
// (2026-09-18). They are the shapes this parser actually has to survive, and
// none of them appears in Vercel's documentation.
const wanTextToVideo = {
  id: "alibaba/wan-v2.5-t2v-preview",
  type: "video",
  video_capabilities: {
    supported_operations: ["text-to-video"],
    supported_resolutions: ["480p", "720p", "1080p"],
    supported_aspect_ratios: ["16:9", "9:16", "1:1", "4:3", "3:4"],
    supported_durations_seconds: [5, 10],
    generate_audio: true,
  },
};

const veo = {
  id: "google/veo-3.1-generate-001",
  type: "video",
  video_capabilities: {
    supported_operations: [
      "text-to-video",
      "image-to-video",
      "first-last-frame",
      "reference-to-video",
      "extend-video",
    ],
    supported_resolutions: ["720p", "1080p", "4k"],
    supported_aspect_ratios: ["16:9", "9:16"],
    supported_durations_seconds: [4, 6, 8],
    generate_audio: true,
  },
};

const minimax = {
  id: "minimax/minimax-h3",
  type: "video",
  video_capabilities: {
    supported_operations: [
      "text-to-video",
      "image-to-video",
      "reference-to-video",
      "first-last-frame",
    ],
    supported_resolutions: ["2k", "768p"],
    supported_aspect_ratios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    supported_durations_seconds: [4, 5, 6, 7, 8, 9, 10],
    generate_audio: true,
  },
};

const motionControl = {
  id: "klingai/kling-v2.6-motion-control",
  type: "video",
  video_capabilities: {
    supported_operations: ["motion-control"],
    supported_resolutions: ["720p", "1080p"],
    supported_aspect_ratios: ["16:9", "9:16", "1:1"],
    supported_durations_seconds: [3, 4, 5],
    generate_audio: false,
  },
};

describe("reading one Gateway video model", () => {
  it("does not infer mandatory audio from a model ID or generate_audio", () => {
    expect(toVideoModelDescriptor(minimax).audioRequired).toBeUndefined();
    expect(toVideoModelDescriptor(veo).audioRequired).toBeUndefined();
    expect(toVideoModelDescriptor({ id: "minimax/future-model", type: "video" }).audioRequired)
      .toBeUndefined();
  });

  it("drops the sizes this service will not price", () => {
    // 4K carries four times 1080p's pixels at a price set against 1080p, and
    // 768p has no name here at all. Both have to disappear before a screen can
    // offer them.
    expect(toVideoModelDescriptor(veo).supportedResolutions).toEqual([
      "720p",
      "1080p",
    ]);
    expect(toVideoModelDescriptor(minimax).supportedResolutions).toEqual(["2K"]);
  });

  it("derives the frames a model takes from its operations", () => {
    // The Gateway has no frame field; only the operation names say so.
    expect(toVideoModelDescriptor(veo).supportedFrameImages).toEqual([
      "first_frame",
      "last_frame",
    ]);
    // Text-to-video only: an empty list, not "unrestricted". Reading this as
    // no restriction would offer a starting frame on a model that refuses one.
    expect(toVideoModelDescriptor(wanTextToVideo).supportedFrameImages).toEqual(
      [],
    );
  });

  it("marks a model that does not generate from a prompt", () => {
    // Kling's motion-control models publish resolutions, lengths and shapes
    // like any other. Nothing but the operation list says they cannot take an
    // ordinary prompt, and offering one would only ever be refused.
    expect(toVideoModelDescriptor(motionControl).supportsPromptToVideo).toBe(
      false,
    );
    expect(toVideoModelDescriptor(veo).supportsPromptToVideo).toBe(true);
    expect(
      toVideoModelDescriptor(wanTextToVideo).supportsPromptToVideo,
    ).toBe(true);
  });

  it("reads reference support off the operation list", () => {
    // 15 of the Gateway's 35 video models publish it; nothing else in the
    // metadata distinguishes them.
    expect(toVideoModelDescriptor(veo).supportsReferenceToVideo).toBe(true);
    expect(toVideoModelDescriptor(minimax).supportsReferenceToVideo).toBe(true);
    expect(
      toVideoModelDescriptor(wanTextToVideo).supportsReferenceToVideo,
    ).toBe(false);
    expect(
      toVideoModelDescriptor(motionControl).supportsReferenceToVideo,
    ).toBe(false);
  });

  it("states nothing where the provider states nothing", () => {
    // A field the provider omits is not a restriction. The seed is never
    // published, and the request API takes one.
    const bare = toVideoModelDescriptor({ id: "x/y", type: "video" });
    expect(bare).toEqual({
      id: "x/y",
      supportedResolutions: null,
      supportedDurations: null,
      supportedAspectRatios: null,
      supportedFrameImages: null,
      generateAudio: null,
      seed: null,
      supportsPromptToVideo: null,
      supportsReferenceToVideo: null,
      supportsVideoEditing: null,
      supportsVideoExtension: null,
      supportsMotionControl: null,
      inputLimits: UNSTATED_VIDEO_INPUT_LIMITS,
    });
  });

  it("reads the allowances a model publishes", () => {
    // MiniMax H3's, as the live list gives them. Nine pictures and three
    // videos is what it takes; offering three and one throws most of it away.
    const described = toVideoModelDescriptor({
      id: "minimax/minimax-h3",
      type: "video",
      video_capabilities: {
        supported_operations: ["text-to-video", "reference-to-video"],
        input_limits: {
          image: { max_count: 9, max_file_size_mb: 30 },
          video: {
            max_count: 3,
            max_file_size_mb: 50,
            min_duration_seconds: 2,
            max_duration_seconds: 15,
          },
          text: { max_chars: 2500 },
          max_total_inputs: 5,
        },
      },
    });

    expect(described.inputLimits).toEqual({
      maxImages: 9,
      maxImageBytes: 30 * 1024 * 1024,
      maxVideos: 3,
      maxVideoBytes: 50 * 1024 * 1024,
      minVideoDurationSeconds: 2,
      maxVideoDurationSeconds: 15,
      maxAudio: null,
      maxAudioBytes: null,
      minAudioDurationSeconds: null,
      maxAudioDurationSeconds: null,
      maxPromptCharacters: 2500,
      maxTotalInputs: 5,
    });
  });

  it("drops an allowance that cannot mean anything", () => {
    // The block is undocumented, so a zero or a negative is read as "nothing
    // stated" rather than as "none allowed" — which would take the model's
    // whole input surface offline.
    const described = toVideoModelDescriptor({
      id: "x/y",
      type: "video",
      video_capabilities: {
        input_limits: {
          image: { max_count: 0, max_file_size_mb: -1 },
          text: { max_chars: 0 },
        },
      },
    });

    expect(described.inputLimits).toEqual(UNSTATED_VIDEO_INPUT_LIMITS);
  });
});

describe("reading the whole Gateway model list", () => {
  const respondWith = (body: unknown, status = 200) =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

  it("keeps only the video models", async () => {
    const models = await listGatewayVideoModels(
      respondWith({
        data: [
          { id: "alibaba/qwen-3-14b", type: "language" },
          veo,
          { id: "openai/gpt-image-2", type: "image" },
          wanTextToVideo,
        ],
      }),
    );

    expect(models.map((model) => model.id)).toEqual([
      "google/veo-3.1-generate-001",
      "alibaba/wan-v2.5-t2v-preview",
    ]);
  });

  it("drops one unreadable entry rather than the whole list", async () => {
    // The shape is undocumented. One model growing a field that does not parse
    // must not take the other thirty-four offline.
    const models = await listGatewayVideoModels(
      respondWith({
        data: [
          { type: "video" },
          { id: 42, type: "video" },
          veo,
        ],
      }),
    );

    expect(models.map((model) => model.id)).toEqual([
      "google/veo-3.1-generate-001",
    ]);
  });

  it("reports a refused request as a provider error", async () => {
    await expect(
      listGatewayVideoModels(respondWith({ error: "nope" }, 503)),
    ).rejects.toThrow(AiProviderError);
  });

  it("reports an unreadable body as a provider error", async () => {
    const notJson = (async () =>
      new Response("<html>gateway down</html>", {
        status: 200,
      })) as unknown as typeof fetch;

    await expect(listGatewayVideoModels(notJson)).rejects.toThrow(
      AiProviderError,
    );
  });
});
