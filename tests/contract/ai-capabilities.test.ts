import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { setDbProvider, upsertAiSetting } from "@beutl/db";
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
      model: "openai/gpt-image-1",
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
    expect((await response.json()).operations["video.generate"].model).toBe(
      "google/veo-3.1-lite",
    );
  });

  it("never reports what anything costs", async () => {
    const response = await makeApp().request("/api/v3/ai/capabilities", {
      headers: await authHeaders(),
    });

    const serialized = JSON.stringify(await response.json());
    for (const forbidden of ["price", "cost", "usageUnits", "credit"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
