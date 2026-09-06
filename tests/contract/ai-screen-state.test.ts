import { describe, expect, it } from "vitest";
import type { AiVideoModelCapabilities } from "@beutl/api";
import type { AiAccess } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/ai/shared";
import { buildAiVideoScreenOptions } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/ai/video-options";

describe("video screen options", () => {
  it("filters models with the request-scoped capability snapshot", () => {
    const supported: AiVideoModelCapabilities = {
      modelId: "video/supported",
      resolutions: ["720p"],
      durations: [4],
      aspectRatios: ["16:9"],
      generateAudio: true,
      seed: false,
      firstFrame: true,
      lastFrame: false,
    };
    const unusable: AiVideoModelCapabilities = {
      ...supported,
      modelId: "video/unusable",
      resolutions: [],
    };
    const access: AiAccess = {
      canUseAi: true,
      availability: { "video.generate": true },
      models: {
        "video.generate": [
          {
            id: supported.modelId,
            displayName: "Supported",
            costTier: "low",
            available: true,
          },
          {
            id: unusable.modelId,
            displayName: "Unusable",
            costTier: "medium",
            available: true,
          },
          {
            id: "video/not-listed",
            displayName: "Provider list unavailable",
            costTier: "high",
            available: true,
          },
        ],
      },
    };
    const capabilities = new Map([
      [supported.modelId, supported],
      [unusable.modelId, unusable],
    ]);

    const { models, modelOptions } = buildAiVideoScreenOptions(
      access,
      capabilities,
    );

    expect(models.map((model) => model.id)).toEqual([
      "video/supported",
      "video/not-listed",
    ]);
    expect(modelOptions).toEqual({
      "video/supported": {
        resolutions: ["720p"],
        durations: [4],
        aspectRatios: ["16:9"],
        generateAudio: true,
        seed: false,
        firstFrame: true,
        lastFrame: false,
      },
    });
  });
});
