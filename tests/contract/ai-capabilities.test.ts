import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { setDbProvider, upsertAiOperationModel } from "@beutl/db";
import {
  AI_IMAGE_ASPECT_RATIOS,
  AI_IMAGE_BACKGROUNDS,
  AI_MAX_IMAGE_REFERENCES,
} from "@beutl/core";

// What a video model accepts comes from the provider. Mocked so the endpoint's
// shape is tested without a network call deciding the expectations.
const listVideoModels = vi.hoisted(() => vi.fn());
vi.mock("../../packages/api/src/ai/openrouter-video", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../packages/api/src/ai/openrouter-video")
  >();
  return { ...actual, listVideoModels };
});
// What an image model takes is one lookup per model; the endpoint's shape is
// tested without any of them going over the wire.
const loadAiImageModelCapabilities = vi.hoisted(() =>
  vi.fn(async () => new Map()),
);
vi.mock(
  "../../packages/api/src/ai/image-model-capabilities",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("../../packages/api/src/ai/image-model-capabilities")
    >();
    return { ...actual, loadAiImageModelCapabilities };
  },
);

import { v3 } from "@beutl/api";
import { clearAiVideoModelCapabilitiesCache } from "../../packages/api/src/ai/video-model-capabilities";
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

// A model entry as the endpoint reports it when the provider says nothing about
// the model: every shape this service knows how to ask for stays on offer.
function imageModel(
  id: string,
  displayName: string,
  costTier: string | null,
  isDefault: boolean,
) {
  return {
    id,
    displayName,
    costTier,
    isDefault,
    aspectRatios: [...AI_IMAGE_ASPECT_RATIOS],
    backgrounds: [...AI_IMAGE_BACKGROUNDS],
    seed: true,
    maxReferenceImages: AI_MAX_IMAGE_REFERENCES,
  };
}

describe("GET /api/v3/ai/capabilities", () => {
  beforeEach(() => {
    const memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
    process.env.JWT_SECRET = JWT_SECRET;
    listVideoModels.mockReset();
    listVideoModels.mockResolvedValue([]);
    clearAiVideoModelCapabilitiesCache();
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
      backgrounds: ["auto", "opaque", "transparent"],
      maxReferenceImages: AI_MAX_IMAGE_REFERENCES,
      outputFormat: "png",
    });
    expect(body.operations["video.generate"]).toMatchObject({
      // The span the server considers, not a menu: each model publishes the
      // seconds it actually takes on its own entry.
      minDurationSeconds: 1,
      maxDurationSeconds: 60,
      resolutions: expect.arrayContaining(["720p", "1080p", "2K"]),
      aspectRatios: expect.arrayContaining(["16:9", "9:16"]),
      audio: true,
    });
    expect(body.operations["image.edit.restyle"]).toMatchObject({
      promptRequired: true,
    });
    expect(body.operations["image.edit.remove_background"]).toMatchObject({
      promptRequired: false,
    });
  });

  it("follows the model an administrator registered", async () => {
    await upsertAiOperationModel({
      operation: "video.generate",
      modelId: "google/veo-3.1-lite",
      priceUnits: 40,
      displayName: null,
      sortOrder: 0,
      enabled: true,
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
        // A model the provider says nothing about keeps everything the
        // operation itself offers.
        durationsSeconds: expect.arrayContaining([4, 6, 8]),
        resolutions: ["480p", "720p", "1080p", "2K"],
        aspectRatios: ["16:9", "9:16", "4:3", "3:4", "1:1"],
        audio: true,
        seed: true,
      },
    ]);
  });

  it("reports each video model's own accepted parameters", async () => {
    // The provider decides these per model, and a fixed list of options
    // produces requests some models reject after the usage is reserved.
    listVideoModels.mockResolvedValue([
      {
        id: "narrow/model",
        supportedResolutions: ["720p"],
        supportedDurations: [4, 5, 6],
        supportedAspectRatios: ["16:9"],
        supportedFrameImages: ["first_frame"],
        generateAudio: false,
        seed: false,
      },
    ]);
    await upsertAiOperationModel({
      operation: "video.generate",
      modelId: "narrow/model",
      priceUnits: 30,
      displayName: null,
      sortOrder: 0,
      enabled: true,
      updatedBy: "admin-1",
    });

    const response = await makeApp().request("/api/v3/ai/capabilities", {
      headers: await authHeaders(),
    });
    const video = (await response.json()).operations["video.generate"];

    expect(video.models).toEqual([
      {
        id: "narrow/model",
        displayName: "narrow/model",
        costTier: null,
        isDefault: true,
        // The model's own lengths, not a fixed menu it has to fit into.
        durationsSeconds: [4, 5, 6],
        resolutions: ["720p"],
        aspectRatios: ["16:9"],
        audio: false,
        seed: false,
      },
    ]);
    // The operation-level lists stay the superset the server will take at all,
    // so a client that ignores the per-model values still sees the full range.
    expect(video.resolutions).toEqual(["480p", "720p", "1080p", "2K"]);
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
      // Each carries what it takes as well, exactly as a video model does; a
      // model the provider says nothing about keeps every shape on offer.
      imageModel("dear/model", "Dear", "high", true),
      imageModel("cheap/model", "cheap/model", "low", false),
      imageModel("middling/model", "middling/model", "medium", false),
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
