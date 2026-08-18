import { beforeEach, describe, expect, it } from "vitest";
import {
  consumeUsage,
  setDbProvider,
  upsertAiOperationModel,
  upsertSubscription,
} from "@beutl/db";
import { getEntitlements } from "@beutl/api";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const USER_ID = "entitlements-user";
const PERIOD_START = new Date(Date.now() - 24 * 60 * 60 * 1_000);
const PERIOD_END = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000);
const MONTHLY_LIMIT = 500;
// Defaults from @beutl/core: a second of video costs 40 units and the shortest
// clip that can be requested is four seconds.
const VIDEO_UNIT_PRICE = 40;
const VIDEO_MINIMUM_SECONDS = 4;

describe("AI entitlements", () => {
  let state: ReturnType<typeof createInMemoryPrisma>["state"];

  beforeEach(() => {
    const memory = createInMemoryPrisma();
    state = memory.state;
    setDbProvider(async () => memory.prisma as never);
  });

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
    const entitlements = await getEntitlements(USER_ID);

    expect(entitlements.canUseAi).toBe(false);
    expect(entitlements.balance.additionalCredits).toBe(0);
    // A signed-in visitor to any page that shows an allowance reaches this, and
    // the rows it used to create counted as accounts in the admin reports.
    expect(state.creditAccounts.size).toBe(0);
  });

  it("reports a video as startable only once the shortest clip is affordable", async () => {
    await activatePro();
    // Two seconds of video left: enough for a unit, not for a request.
    await consumeUsage({
      userId: USER_ID,
      amount: MONTHLY_LIMIT - VIDEO_UNIT_PRICE * 2,
      monthlyUsageLimit: MONTHLY_LIMIT,
      usagePeriod: { start: PERIOD_START, end: PERIOD_END },
      aiJobId: "entitlements-video-setup",
    });

    const short = await getEntitlements(USER_ID);
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

    const exact = await getEntitlements(USER_ID);
    expect(exact.availability["video.generate"]).toBe(true);
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

    const entitlements = await getEntitlements(USER_ID);

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

    const entitlements = await getEntitlements(USER_ID);

    expect(entitlements.modelAvailability["image.generate"]).toEqual({
      "cheap/model": false,
    });
    expect(entitlements.availability["image.generate"]).toBe(false);
  });
});
