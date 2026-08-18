import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import {
  setDbProvider,
  upsertAiOperationModel,
  upsertAiSetting,
} from "@beutl/db";
import { v3 } from "@beutl/api";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const USER_ID = "ai-capabilities-user";
const JWT_SECRET = "ai-capabilities-test-secret";

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
  return { Authorization: `Bearer ${token}` };
}

describe("GET /api/v3/ai/capabilities", () => {
  beforeEach(() => {
    const memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
    process.env.JWT_SECRET = JWT_SECRET;
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
  });

  it("requires authentication", async () => {
    const response = await makeApp().request("/api/v3/ai/capabilities");

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error_code: "authenticationIsRequired",
    });
  });

  it("reports what each operation accepts, keyed like the availability map", async () => {
    const response = await makeApp().request("/api/v3/ai/capabilities", {
      headers: await authHeaders(),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    // The same keys the entitlements response uses for availability, so a
    // client can line the two up without a mapping table of its own.
    expect(Object.keys(body.operations).sort()).toEqual([
      "audio.transcribe",
      "image.edit.outpaint",
      "image.edit.remove_background",
      "image.edit.remove_object",
      "image.edit.restyle",
      "image.edit.upscale",
      "image.generate",
      "subtitle.translate",
      "video.generate",
    ]);
    expect(body.operations["image.generate"]).toMatchObject({
      models: [
        {
          id: "openai/gpt-image-1",
          displayName: "openai/gpt-image-1",
          // Nothing to be relatively cheaper or dearer than.
          costTier: null,
          isDefault: true,
        },
      ],
      // The values a client used to hard-code, including the two shapes it
      // could not previously ask for at all.
      aspectRatios: expect.arrayContaining(["16:9", "9:16"]),
      backgrounds: ["auto", "transparent"],
      maxReferenceImages: 1,
      outputFormat: "png",
    });
    expect(body.operations["video.generate"]).toMatchObject({
      durationsSeconds: [4, 6, 8],
      resolutions: ["720p", "1080p"],
      aspectRatios: ["16:9", "9:16"],
      audio: true,
    });
    expect(body.operations["image.edit.restyle"]).toMatchObject({
      promptRequired: true,
    });
    expect(body.operations["image.edit.remove_background"]).toMatchObject({
      promptRequired: false,
    });
  });

  it("follows the model an administrator configured", async () => {
    await upsertAiSetting({
      key: "model.video.generate",
      value: "google/veo-3.1-lite",
      updatedBy: "admin-1",
    });

    const response = await makeApp().request("/api/v3/ai/capabilities", {
      headers: await authHeaders(),
    });

    // This is the point of the endpoint: swapping a model in the admin console
    // must not require a desktop release to stay in step.
    expect(
      (await response.json()).operations["video.generate"].models,
    ).toEqual([
      {
        id: "google/veo-3.1-lite",
        displayName: "google/veo-3.1-lite",
        costTier: null,
        isDefault: true,
      },
    ]);
  });

  it("lists every registered model, ordered, with the first as the default", async () => {
    for (const [modelId, priceUnits, sortOrder, displayName] of [
      ["dear/model", 40, 0, "Dear"],
      ["cheap/model", 6, 1, null],
      ["middling/model", 18, 2, null],
    ] as const) {
      await upsertAiOperationModel({
        operation: "image.generate",
        modelId,
        priceUnits,
        displayName,
        sortOrder,
        enabled: true,
        updatedBy: "admin-1",
      });
    }

    const response = await makeApp().request("/api/v3/ai/capabilities", {
      headers: await authHeaders(),
    });

    // Display order is the administrator's; the tiers follow the real prices,
    // which is why the dearest model can still be shown first.
    expect(
      (await response.json()).operations["image.generate"].models,
    ).toEqual([
      { id: "dear/model", displayName: "Dear", costTier: "high", isDefault: true },
      {
        id: "cheap/model",
        displayName: "cheap/model",
        costTier: "low",
        isDefault: false,
      },
      {
        id: "middling/model",
        displayName: "middling/model",
        costTier: "medium",
        isDefault: false,
      },
    ]);
  });

  it("never reports what anything costs", async () => {
    await upsertAiOperationModel({
      operation: "image.generate",
      modelId: "dear/model",
      priceUnits: 4321,
      displayName: null,
      sortOrder: 0,
      enabled: true,
      updatedBy: "admin-1",
    });

    const response = await makeApp().request("/api/v3/ai/capabilities", {
      headers: await authHeaders(),
    });

    const body = await response.json();
    const serialized = JSON.stringify(body);
    for (const forbidden of ["price", "usageUnits", "credit"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    // The registered price must not reach the client in any form.
    expect(serialized).not.toContain("4321");
    // costTier is the one thing said about relative cost, and it is a label
    // rather than an amount: no arithmetic can recover a unit price from it.
    for (const operation of Object.values(body.operations) as {
      models: { costTier: unknown }[];
    }[]) {
      for (const model of operation.models) {
        expect([null, "low", "medium", "high"]).toContain(model.costTier);
      }
    }
  });
});
