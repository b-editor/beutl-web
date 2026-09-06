import { beforeEach, describe, expect, it, vi } from "vitest";

const getEntitlements = vi.hoisted(() => vi.fn());
const loadAiModelCatalog = vi.hoisted(() => vi.fn());
const getDb = vi.hoisted(() => vi.fn());
const listAiJobsByUserId = vi.hoisted(() => vi.fn());

vi.mock("@beutl/api", () => ({
  getEntitlements,
  loadAiModelCatalog,
}));
vi.mock("@beutl/db", () => ({ getDb, listAiJobsByUserId }));

import { getAiScreenState } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/ai/queries";

describe("AI screen state", () => {
  const prisma = {};

  beforeEach(() => {
    getEntitlements.mockReset();
    loadAiModelCatalog.mockReset();
    getDb.mockReset();
    getDb.mockResolvedValue(prisma);
    getEntitlements.mockResolvedValue({
      canUseAi: true,
      availability: {},
      modelAvailability: {},
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
    });
    loadAiModelCatalog.mockResolvedValue({
      operations: () => [],
      list: () => [],
    });
  });

  it("keeps non-video screens independent of video capability discovery", async () => {
    await getAiScreenState("user-1");

    expect(getEntitlements).toHaveBeenCalledWith("user-1", {
      catalog: expect.any(Promise),
      prisma,
      videoCapabilities: expect.any(Map),
    });
    const options = getEntitlements.mock.calls[0]?.[1];
    expect(options.videoCapabilities).toEqual(new Map());
    expect(options.catalog).toBe(loadAiModelCatalog.mock.results[0]?.value);
    expect(loadAiModelCatalog).toHaveBeenCalledWith({ prisma });
    expect(getDb).toHaveBeenCalledOnce();
    expect(loadAiModelCatalog).toHaveBeenCalledOnce();
  });

  it("shares the caller's request-scoped video capability read", async () => {
    const videoCapabilities = Promise.resolve(new Map([
      ["video/model", { durations: [4, 6] }],
    ]));

    await getAiScreenState("user-1", { videoCapabilities });

    expect(getEntitlements).toHaveBeenCalledWith("user-1", {
      catalog: expect.any(Promise),
      prisma,
      videoCapabilities,
    });
    expect(getDb).toHaveBeenCalledOnce();
    expect(loadAiModelCatalog).toHaveBeenCalledOnce();
  });
});
