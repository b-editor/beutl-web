import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeUsage,
  setDbProvider,
  upsertAiOperationModel,
  upsertSubscription,
} from "@beutl/db";
import { getEntitlements, getEntitlementSummary } from "@beutl/api";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const USER_ID = "entitlements-user";
const PERIOD_START = new Date(Date.now() - 24 * 60 * 60 * 1_000);
const PERIOD_END = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000);
const MONTHLY_LIMIT = 500;
// The built-in Veo model costs 40 units a second and supports 4/6/8 seconds.
const VIDEO_UNIT_PRICE = 40;
const VIDEO_MINIMUM_SECONDS = 4;

describe("AI entitlements", () => {
  let state: ReturnType<typeof createInMemoryPrisma>["state"];
  let prisma: ReturnType<typeof createInMemoryPrisma>["prisma"];

  beforeEach(() => {
    const memory = createInMemoryPrisma();
    state = memory.state;
    prisma = memory.prisma;
    setDbProvider(async () => prisma as never);
  });

  const videoCapabilities = new Map([
    ["google/veo-3.1", { durations: [4, 6, 8] }],
  ]);

  const readEntitlements = (
    capabilities: ReadonlyMap<string, { durations: readonly number[] }> =
      videoCapabilities,
  ) => getEntitlements(USER_ID, { videoCapabilities: capabilities });

  async function activatePro() {
    await upsertSubscription({
      userId: USER_ID,
      stripeSubscriptionId: "sub_entitlements",
      status: "active",
      planId: "pro",
      billingOfferId: "offer_pro_test",
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: PERIOD_END,
      cancelAt: null,
    });
  }

  it("opens no ledger row for someone who only looked", async () => {
    const entitlements = await readEntitlements();

    expect(entitlements.canUseAi).toBe(false);
    expect(entitlements.balance.additionalCredits).toBe(0);
    // A signed-in visitor to any page that shows an allowance reaches this, and
    // the rows it used to create counted as accounts in the admin reports.
    expect(state.creditAccounts.size).toBe(0);
  });

  it("reads account summary without loading provider or model availability", async () => {
    await activatePro();
    const catalogRead = vi
      .spyOn(prisma.aiOperationModel, "findMany")
      .mockRejectedValue(new Error("model catalog must not be loaded"));

    const summary = await getEntitlementSummary(USER_ID);

    expect(summary.canUseAi).toBe(true);
    expect(summary.plan).toBe("pro");
    expect(summary.balance.monthlyUsage.remainingPercent).toBe(100);
    expect(catalogRead).not.toHaveBeenCalled();
    expect(summary).not.toHaveProperty("availability");
    expect(summary).not.toHaveProperty("modelAvailability");
  });

  it("keeps summary fields identical to the full entitlement response", async () => {
    await activatePro();
    await consumeUsage({
      userId: USER_ID,
      amount: 125,
      monthlyUsageLimit: MONTHLY_LIMIT,
      usagePeriod: { start: PERIOD_START, end: PERIOD_END },
      aiJobId: "entitlements-summary-parity",
    });

    const summary = await getEntitlementSummary(USER_ID);
    const full = await readEntitlements();
    const { availability: _availability, modelAvailability: _models, ...base } =
      full;

    expect(summary).toEqual(base);
  });

  it("reports a video as startable only once the shortest clip is affordable", async () => {
    await activatePro();
    // Less than four seconds of allowance cannot start the shortest valid clip.
    await consumeUsage({
      userId: USER_ID,
      amount: MONTHLY_LIMIT - VIDEO_UNIT_PRICE * VIDEO_MINIMUM_SECONDS + 1,
      monthlyUsageLimit: MONTHLY_LIMIT,
      usagePeriod: { start: PERIOD_START, end: PERIOD_END },
      aiJobId: "entitlements-video-setup",
    });

    const short = await readEntitlements();
    expect(short.availability["video.generate"]).toBe(false);
    // Operations billed per request are unaffected by the video minimum.
    expect(short.availability["image.edit.remove_background"]).toBe(true);

    const memory = createInMemoryPrisma();
    state = memory.state;
    setDbProvider(async () => memory.prisma as never);
    await activatePro();
    await consumeUsage({
      userId: USER_ID,
      amount: MONTHLY_LIMIT - VIDEO_UNIT_PRICE * VIDEO_MINIMUM_SECONDS,
      monthlyUsageLimit: MONTHLY_LIMIT,
      usagePeriod: { start: PERIOD_START, end: PERIOD_END },
      aiJobId: "entitlements-video-setup",
    });

    const exact = await readEntitlements();
    expect(exact.availability["video.generate"]).toBe(true);
  });

  it("disables AI entitlements while account deletion is authorized", async () => {
    await activatePro();
    state.accountDeletionIntents.set("delete-intent", {
      identifier: "entitlements-user@example.com",
      tokenHash: "delete-token-hash",
      userId: USER_ID,
      stripeCustomerId: null,
      authorizedAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
    });

    const entitlements = await readEntitlements();

    expect(entitlements.canUseAi).toBe(false);
    expect(entitlements.plan).toBeNull();
    expect(entitlements.availability["image.generate"]).toBe(false);
  });

  it("uses each video model's shortest supported duration", async () => {
    await activatePro();
    for (const [modelId, sortOrder] of [["video/short", 0], ["video/long", 1]] as const) {
      await upsertAiOperationModel({
        operation: "video.generate",
        modelId,
        priceUnits: VIDEO_UNIT_PRICE,
        displayName: null,
        sortOrder,
        enabled: true,
        updatedBy: "admin-1",
      });
    }
    await consumeUsage({
      userId: USER_ID,
      amount: MONTHLY_LIMIT - VIDEO_UNIT_PRICE * 3,
      monthlyUsageLimit: MONTHLY_LIMIT,
      usagePeriod: { start: PERIOD_START, end: PERIOD_END },
      aiJobId: "entitlements-video-model-minimum",
    });

    const entitlements = await readEntitlements(new Map([
      ["video/short", { durations: [2, 4] }],
      ["video/long", { durations: [5, 8] }],
    ]));

    expect(entitlements.modelAvailability["video.generate"]).toEqual({
      "video/short": true,
      "video/long": false,
    });
    expect(entitlements.availability["video.generate"]).toBe(true);
  });

  it("says which models are affordable, and calls the operation available if any is", async () => {
    await activatePro();
    for (const [modelId, priceUnits, sortOrder] of [
      ["cheap/model", 10, 0],
      ["dear/model", 400, 1],
    ] as const) {
      await upsertAiOperationModel({
        operation: "image.generate",
        modelId,
        priceUnits,
        displayName: null,
        sortOrder,
        enabled: true,
        updatedBy: "admin-1",
      });
    }
    await consumeUsage({
      userId: USER_ID,
      amount: MONTHLY_LIMIT - 100,
      monthlyUsageLimit: MONTHLY_LIMIT,
      usagePeriod: { start: PERIOD_START, end: PERIOD_END },
      aiJobId: "entitlements-model-setup",
    });

    const entitlements = await readEntitlements();

    expect(entitlements.modelAvailability["image.generate"]).toEqual({
      "cheap/model": true,
      "dear/model": false,
    });
    // Being unable to afford the dearest model is not the same as being unable
    // to generate an image at all.
    expect(entitlements.availability["image.generate"]).toBe(true);
  });

  it("reports every model as unavailable without a plan", async () => {
    await upsertAiOperationModel({
      operation: "image.generate",
      modelId: "cheap/model",
      priceUnits: 1,
      displayName: null,
      sortOrder: 0,
      enabled: true,
      updatedBy: "admin-1",
    });

    const entitlements = await readEntitlements();

    expect(entitlements.modelAvailability["image.generate"]).toEqual({
      "cheap/model": false,
    });
    expect(entitlements.availability["image.generate"]).toBe(false);
  });
});
