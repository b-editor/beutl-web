import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getEntitlements: vi.fn(),
  isVideoModelUsable: vi.fn((capabilities: {
    resolutions: readonly string[];
    durations: readonly number[];
    aspectRatios: readonly string[];
  } | undefined) =>
    capabilities === undefined ||
    (capabilities.resolutions.length > 0 &&
      capabilities.durations.length > 0 &&
      capabilities.aspectRatios.length > 0)
  ),
  loadAiModelCatalog: vi.fn(),
  loadAiVideoModelCapabilities: vi.fn(),
}));

vi.mock("@beutl/api", () => api);
vi.mock("@beutl/db", () => ({
  listAiJobsByUserId: vi.fn(),
}));

import { getAiScreenState } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/ai/queries";
import { buildAiVideoScreenOptions } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/ai/video-options";

describe("server-rendered AI screen state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shares one capability map and catalog with entitlement presentation", async () => {
    const videoCapabilities = new Map([
      [
        "video/model-a",
        {
          modelId: "video/model-a",
          resolutions: ["720p"],
          durations: [4],
          aspectRatios: ["16:9"],
          generateAudio: true,
          seed: true,
          firstFrame: true,
          lastFrame: false,
        },
      ],
    ]);
    const videoEntry = {
      operation: "video.generate",
      modelId: "video/model-a",
      priceUnits: 25,
      displayName: "Video A",
      sortOrder: 0,
      costTier: null,
    };
    const catalog = {
      list: vi.fn((operation: string) =>
        operation === "video.generate" ? [videoEntry] : []
      ),
      getDefault: vi.fn(() => videoEntry),
      resolve: vi.fn(() => videoEntry),
      operations: vi.fn(() => ["video.generate"]),
    };
    api.loadAiVideoModelCapabilities.mockResolvedValue(videoCapabilities);
    api.loadAiModelCatalog.mockResolvedValue(catalog);
    api.getEntitlements.mockImplementation(
      async (_userId: string, options: Record<string, unknown>) => {
        expect(options.videoCapabilities).toBe(videoCapabilities);
        expect(options.catalog).toBe(catalog);
        return {
          canUseAi: true,
          availability: { "video.generate": true },
          modelAvailability: {
            "video.generate": { "video/model-a": true },
          },
          balance: {
            monthlyUsage: {
              usedPercent: 10,
              remainingPercent: 90,
              isExhausted: false,
            },
            additionalCredits: 0,
            hasAdditionalCreditDebt: false,
          },
          currentPeriodEnd: "2026-10-01T00:00:00.000Z",
          cancelAtPeriodEnd: false,
        };
      },
    );

    const state = await getAiScreenState("user-1");

    expect(api.loadAiVideoModelCapabilities).toHaveBeenCalledTimes(1);
    expect(api.loadAiModelCatalog).toHaveBeenCalledTimes(1);
    expect(api.getEntitlements).toHaveBeenCalledTimes(1);
    expect(state.videoCapabilities).toBe(videoCapabilities);
    expect(state.access.models["video.generate"]).toEqual([
      {
        id: "video/model-a",
        displayName: "Video A",
        costTier: null,
        available: true,
      },
    ]);
  });

  it("filters VideoForm options with the capability map used by entitlements", async () => {
    const supported = {
      modelId: "video/supported",
      resolutions: ["720p"],
      durations: [4],
      aspectRatios: ["16:9"],
      generateAudio: true,
      seed: false,
      firstFrame: true,
      lastFrame: false,
    };
    const unusable = {
      ...supported,
      modelId: "video/unusable",
      resolutions: [],
    };
    const videoCapabilities = new Map([
      [supported.modelId, supported],
      [unusable.modelId, unusable],
    ]);
    const entries = [supported, unusable].map((capability, sortOrder) => ({
      operation: "video.generate",
      modelId: capability.modelId,
      priceUnits: 25,
      displayName: capability.modelId,
      sortOrder,
      costTier: sortOrder === 0 ? "low" : "high",
    }));
    const catalog = {
      list: vi.fn(() => entries),
      getDefault: vi.fn(() => entries[0]),
      resolve: vi.fn(() => entries[0]),
      operations: vi.fn(() => ["video.generate"]),
    };
    api.loadAiVideoModelCapabilities.mockResolvedValue(videoCapabilities);
    api.loadAiModelCatalog.mockResolvedValue(catalog);
    api.getEntitlements.mockImplementation(
      async (_userId: string, options: Record<string, unknown>) => {
        expect(options.videoCapabilities).toBe(videoCapabilities);
        return {
          canUseAi: true,
          availability: { "video.generate": true },
          modelAvailability: {
            "video.generate": {
              "video/supported": true,
              "video/unusable": true,
            },
          },
          balance: {
            monthlyUsage: {
              usedPercent: 0,
              remainingPercent: 100,
              isExhausted: false,
            },
            additionalCredits: 0,
            hasAdditionalCreditDebt: false,
          },
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
        };
      },
    );

    const state = await getAiScreenState("user-1");
    const { models, modelOptions } = buildAiVideoScreenOptions(
      state.access,
      state.videoCapabilities,
    );

    expect(api.loadAiVideoModelCapabilities).toHaveBeenCalledTimes(1);
    expect(api.isVideoModelUsable).toHaveBeenNthCalledWith(1, supported);
    expect(api.isVideoModelUsable).toHaveBeenNthCalledWith(2, unusable);
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
    expect(models).toEqual([
      expect.objectContaining({ id: "video/supported" }),
    ]);
  });
});
