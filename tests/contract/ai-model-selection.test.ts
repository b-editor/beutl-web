import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import {
  getCreditAccount,
  setDbProvider,
  upsertAiOperationModel,
  upsertSubscription,
} from "@beutl/db";
import { setR2BucketProvider, v3 } from "@beutl/api";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

// What a caller may choose, and what that choice costs. The two must come out
// of the same resolution: charging one model's price for another model's work
// is the failure this file exists to catch.
vi.mock("../../packages/api/src/ai/openrouter", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../packages/api/src/ai/openrouter")
  >();
  return { ...actual, generateImage: vi.fn() };
});
// Keeps the capability lookup off the network; what each video model accepts is
// covered by the capabilities contract.
vi.mock("../../packages/api/src/ai/openrouter-video", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../packages/api/src/ai/openrouter-video")
  >();
  return { ...actual, listVideoModels: vi.fn().mockResolvedValue([]) };
});
vi.mock(
  "../../packages/api/src/ai/image-model-capabilities",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("../../packages/api/src/ai/image-model-capabilities")
    >();
    return {
      ...actual,
      loadAiImageModelCapabilities: vi.fn(async () => new Map()),
    };
  },
);

import { generateImage } from "../../packages/api/src/ai/openrouter";

const USER_ID = "user-model-selection";
const JWT_SECRET = "test-secret-for-model-selection";
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function makeApp() {
  return new Hono().basePath("/api/v3").route("/", v3);
}

async function authHeaders(idempotencyKey = crypto.randomUUID()) {
  const token = await sign(
    {
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier":
        USER_ID,
      exp: Math.floor(Date.now() / 1000) + 300,
    },
    JWT_SECRET,
    "HS256",
  );
  return {
    Authorization: `Bearer ${token}`,
    "Idempotency-Key": idempotencyKey,
    "content-type": "application/json",
  };
}

async function activatePro() {
  await upsertSubscription({
    userId: USER_ID,
    stripeSubscriptionId: "sub_model_selection",
    status: "active",
    planId: "pro",
    billingOfferId: "offer_pro_test",
    currentPeriodStart: new Date(Date.now() - 24 * 60 * 60 * 1000),
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    cancelAt: null,
  });
}

async function registerImageModels() {
  await upsertAiOperationModel({
    operation: "image.generate",
    modelId: "cheap/model",
    priceUnits: 7,
    displayName: null,
    sortOrder: 0,
    enabled: true,
    updatedBy: "admin-1",
  });
  await upsertAiOperationModel({
    operation: "image.generate",
    modelId: "dear/model",
    priceUnits: 31,
    displayName: "Dear",
    sortOrder: 1,
    enabled: true,
    updatedBy: "admin-1",
  });
}

async function generateWith(
  body: Record<string, unknown>,
  idempotencyKey?: string,
) {
  return await makeApp().request("/api/v3/ai/images", {
    method: "POST",
    headers: await authHeaders(idempotencyKey),
    body: JSON.stringify({ prompt: "a cat", aspectRatio: "1:1", ...body }),
  });
}

describe("choosing a model per request", () => {
  let state: ReturnType<typeof createInMemoryPrisma>["state"];

  beforeEach(async () => {
    vi.clearAllMocks();
    const memory = createInMemoryPrisma();
    state = memory.state;
    setDbProvider(async () => memory.prisma as never);
    setR2BucketProvider(() => ({
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    }));
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.PUBLIC_ORIGIN = "https://beutl.beditor.net";
    vi.mocked(generateImage).mockResolvedValue({
      b64Json: PNG_BASE64,
      mediaType: "image/png",
    });
    await activatePro();
    await registerImageModels();
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
    delete process.env.PUBLIC_ORIGIN;
  });

  it("charges the chosen model's price and runs the request on it", async () => {
    const response = await generateWith({ model: "dear/model" });

    expect(response.status).toBe(200);
    expect(vi.mocked(generateImage)).toHaveBeenCalledWith(
      expect.objectContaining({ model: "dear/model" }),
    );
    const job = [...state.aiJobs.values()][0];
    expect(job).toMatchObject({ usageUnits: 31, model: "dear/model" });
    expect((await getCreditAccount({ userId: USER_ID })).monthlyUsageUsed)
      .toBe(31);
  });

  it("runs on the first model in display order when none is named", async () => {
    const response = await generateWith({});

    expect(response.status).toBe(200);
    expect(vi.mocked(generateImage)).toHaveBeenCalledWith(
      expect.objectContaining({ model: "cheap/model" }),
    );
    expect([...state.aiJobs.values()][0]).toMatchObject({
      usageUnits: 7,
      model: "cheap/model",
    });
  });

  it("refuses an unknown model without reserving or charging", async () => {
    const response = await generateWith({ model: "never/registered" });

    expect(response.status).toBe(400);
    expect(vi.mocked(generateImage)).not.toHaveBeenCalled();
    expect(state.aiJobs.size).toBe(0);
    expect((await getCreditAccount({ userId: USER_ID })).monthlyUsageUsed)
      .toBe(0);
  });

  it("refuses a model the administrator has disabled", async () => {
    await upsertAiOperationModel({
      operation: "image.generate",
      modelId: "dear/model",
      priceUnits: 31,
      displayName: "Dear",
      sortOrder: 1,
      enabled: false,
      updatedBy: "admin-1",
    });

    const response = await generateWith({ model: "dear/model" });

    // Falling back to the default here would run a model the caller did not
    // ask for and charge that model's price.
    expect(response.status).toBe(400);
    expect(state.aiJobs.size).toBe(0);
  });

  it("treats the same prompt on another model as a different request", async () => {
    const key = "same-key-two-models";
    const first = await generateWith({ model: "cheap/model" }, key);
    expect(first.status).toBe(200);

    const second = await generateWith({ model: "dear/model" }, key);

    // The model is part of the request fingerprint, so this is a reused key
    // carrying different content — refused, not replayed as the cheap result.
    expect(second.status).toBe(409);
    expect(state.aiJobs.size).toBe(1);
  });

  it("reads the model from a multipart request too", async () => {
    // The reference-image and frame-image paths are multipart, and their fields
    // are collected by name: a model left out of that list is silently replaced
    // by the default and charged at the default's price.
    const form = new FormData();
    form.set("prompt", "a cat");
    form.set("aspectRatio", "1:1");
    form.set("model", "dear/model");
    form.set(
      "reference",
      new File([Buffer.from(PNG_BASE64, "base64")], "reference.png", {
        type: "image/png",
      }),
    );
    const { "content-type": _contentType, ...headers } = await authHeaders();

    const response = await makeApp().request("/api/v3/ai/images", {
      method: "POST",
      headers,
      body: form,
    });

    expect(response.status).toBe(200);
    expect(vi.mocked(generateImage)).toHaveBeenCalledWith(
      expect.objectContaining({ model: "dear/model" }),
    );
    expect([...state.aiJobs.values()][0]).toMatchObject({
      usageUnits: 31,
      model: "dear/model",
    });
  });

  it("offers both models to the client without saying what either costs", async () => {
    const response = await makeApp().request("/api/v3/ai/capabilities", {
      headers: await authHeaders(),
    });

    const body = await response.json();
    expect(body.operations["image.generate"].models).toEqual([
      expect.objectContaining({
        id: "cheap/model",
        displayName: "cheap/model",
        costTier: "low",
        isDefault: true,
      }),
      expect.objectContaining({
        id: "dear/model",
        displayName: "Dear",
        costTier: "high",
        isDefault: false,
      }),
    ]);
    // 7 and 31 are what the two are registered at. A model entry carries no
    // number a price could be read out of: video adds the parameters that
    // model accepts, and those are lists of what may be asked for.
    const videoKeys = [
      "aspectRatios",
      "audio",
      "costTier",
      "displayName",
      "durationsSeconds",
      "id",
      "isDefault",
      "resolutions",
      "seed",
    ];
    const imageKeys = [
      "aspectRatios",
      "costTier",
      "displayName",
      "id",
      "isDefault",
      "referenceImages",
      "seed",
      "transparentBackground",
    ];
    for (const [operation, value] of Object.entries(body.operations) as [
      string,
      { models: Record<string, unknown>[] },
    ][]) {
      for (const model of value.models) {
        expect(Object.keys(model).sort()).toEqual(
          operation === "video.generate"
            ? videoKeys
            : operation.startsWith("image.")
              ? imageKeys
              : ["costTier", "displayName", "id", "isDefault"],
        );
        for (const field of Object.values(model)) {
          expect(typeof field).not.toBe("number");
        }
      }
    }
  });
});
