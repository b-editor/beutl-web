import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import {
  consumeUsage,
  setDbProvider,
  upsertAiOperationModel,
  upsertSubscription,
} from "@beutl/db";
import { v3 } from "@beutl/api";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const USER_ID = "ai-availability-user";
const JWT_SECRET = "ai-availability-test-secret";
const PERIOD_START = new Date(Date.now() - 24 * 60 * 60 * 1_000);
const PERIOD_END = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000);

function makeApp() {
  return new Hono().basePath("/api/v3").route("/", v3);
}

async function authHeaders() {
  const token = await sign(
    {
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier":
        USER_ID,
      exp: Math.floor(Date.now() / 1_000) + 300,
    },
    JWT_SECRET,
    "HS256",
  );
  return {
    Authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

async function activatePro() {
  await upsertSubscription({
    userId: USER_ID,
    stripeSubscriptionId: "sub_availability",
    status: "active",
    planId: "pro",
    billingOfferId: "offer_pro_test",
    currentPeriodStart: PERIOD_START,
    currentPeriodEnd: PERIOD_END,
    cancelAt: null,
  });
}

async function checkAvailability(body: object) {
  return await makeApp().request("/api/v3/user/ai-availability", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(body),
  });
}

describe("POST /api/v3/user/ai-availability", () => {
  beforeEach(() => {
    const memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
    process.env.JWT_SECRET = JWT_SECRET;
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
  });

  it("requires authentication", async () => {
    const response = await makeApp().request(
      "/api/v3/user/ai-availability",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "video.generate",
          durationSeconds: 4,
        }),
      },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error_code: "authenticationIsRequired",
    });
  });

  it("uses the requested video duration for the authoritative preflight", async () => {
    await activatePro();
    await consumeUsage({
      userId: USER_ID,
      amount: 300,
      monthlyUsageLimit: 500,
      usagePeriod: { start: PERIOD_START, end: PERIOD_END },
      aiJobId: "availability-setup",
    });

    const fourSeconds = await checkAvailability({
      operation: "video.generate",
      durationSeconds: 4,
    });
    const eightSeconds = await checkAvailability({
      operation: "video.generate",
      durationSeconds: 8,
    });

    expect(await fourSeconds.json()).toEqual({ available: true });
    expect(await eightSeconds.json()).toEqual({ available: false });
  });

  it("uses the requested character count for the authoritative preflight", async () => {
    await activatePro();
    await consumeUsage({
      userId: USER_ID,
      amount: 490,
      monthlyUsageLimit: 500,
      usagePeriod: { start: PERIOD_START, end: PERIOD_END },
      aiJobId: "translation-availability-setup",
    });

    expect(
      await (await checkAvailability({
        operation: "subtitle.translate",
        characterCount: 2_000,
      })).json(),
    ).toEqual({ available: true });
    expect(
      await (await checkAvailability({
        operation: "subtitle.translate",
        characterCount: 11_000,
      })).json(),
    ).toEqual({ available: false });
  });

  it("fails closed without an active plan", async () => {
    const response = await checkAvailability({
      operation: "audio.transcribe",
      durationSeconds: 30,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ available: false });
  });

  it("answers for the model that was named, not the default", async () => {
    await activatePro();
    // The allowance is 500 units; only one of these fits in what is left.
    await consumeUsage({
      userId: USER_ID,
      amount: 460,
      monthlyUsageLimit: 500,
      usagePeriod: { start: PERIOD_START, end: PERIOD_END },
      aiJobId: "model-availability-setup",
    });
    for (const [modelId, priceUnits, sortOrder] of [
      ["cheap/model", 20, 0],
      ["dear/model", 300, 1],
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

    const cheap = await checkAvailability({
      operation: "image.generate",
      model: "cheap/model",
    });
    const dear = await checkAvailability({
      operation: "image.generate",
      model: "dear/model",
    });

    expect(await cheap.json()).toEqual({ available: true });
    expect(await dear.json()).toEqual({ available: false });
  });

  it("answers no for a model that is unknown or disabled", async () => {
    await activatePro();
    await upsertAiOperationModel({
      operation: "image.generate",
      modelId: "retired/model",
      priceUnits: 5,
      displayName: null,
      sortOrder: 0,
      enabled: false,
      updatedBy: "admin-1",
    });

    // Answering yes would send the user into a request the entry point refuses.
    expect(
      await (
        await checkAvailability({
          operation: "image.generate",
          model: "retired/model",
        })
      ).json(),
    ).toEqual({ available: false });
    expect(
      await (
        await checkAvailability({
          operation: "image.generate",
          model: "never/registered",
        })
      ).json(),
    ).toEqual({ available: false });
  });

  it("rejects unsupported quantities and extra fields", async () => {
    await activatePro();

    const invalidDuration = await checkAvailability({
      operation: "video.generate",
      durationSeconds: 61,
    });
    const hiddenPriceProbe = await checkAvailability({
      operation: "image.generate",
      quantity: 100,
    });
    const unboundedAudioDuration = await checkAvailability({
      operation: "audio.transcribe",
      durationSeconds: 1e308,
    });

    expect(invalidDuration.status).toBe(400);
    expect(hiddenPriceProbe.status).toBe(400);
    expect(unboundedAudioDuration.status).toBe(400);
  });
});
