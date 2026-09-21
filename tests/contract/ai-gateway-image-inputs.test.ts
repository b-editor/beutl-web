import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { setDbProvider, upsertAiOperationModel, upsertSubscription } from "@beutl/db";
import { AiProviderError, v3 } from "@beutl/api";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const { generateImage, editImage } = vi.hoisted(() => ({ generateImage: vi.fn(), editImage: vi.fn() }));
vi.mock("../../packages/api/src/ai/providers/vercel-gateway/image", async (original) => ({
  ...(await original<typeof import("../../packages/api/src/ai/providers/vercel-gateway/image")>()),
  generateGatewayImage: generateImage,
  editGatewayImage: editImage,
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const MODEL_ID = "prodia/flux-fast-schnell";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

describe("Gateway image-input admission", () => {
  let state: ReturnType<typeof createInMemoryPrisma>["state"];
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv("JWT_SECRET", "gateway-image-input-test");
    generateImage.mockRejectedValue(new AiProviderError("provider must not be called"));
    editImage.mockRejectedValue(new AiProviderError("provider must not be called"));
    const memory = createInMemoryPrisma();
    state = memory.state;
    setDbProvider(async () => memory.prisma as never);
    await upsertSubscription({
      userId: USER_ID, stripeSubscriptionId: "sub_image_inputs", status: "active", planId: "pro",
      billingOfferId: "offer_pro_test", currentPeriodStart: new Date(Date.now() - 86_400_000),
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000), cancelAt: null,
    });
    for (const operation of ["image.generate", "image.edit.restyle", "image.edit.remove_object"]) {
      await upsertAiOperationModel({
        operation, modelId: MODEL_ID, provider: "vercel-gateway", priceUnits: 20,
        displayName: null, sortOrder: 0, enabled: true, updatedBy: "admin",
      });
    }
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(["restyle", "remove_object", "generate"])("rejects %s image input before reserving usage", async (task) => {
    const token = await sign({
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier": USER_ID,
      exp: Math.floor(Date.now() / 1000) + 300,
    }, "gateway-image-input-test", "HS256");
    const body = new FormData();
    body.set("model", MODEL_ID);
    body.set("prompt", "Make the scene brighter");
    if (task === "generate") body.set("aspectRatio", "1:1");
    else body.set("task", task);
    body.set(task === "generate" ? "reference" : "file", new File([PNG], "source.png", { type: "image/png" }));

    const response = await new Hono().basePath("/api/v3").route("/", v3).request(
      `/api/v3/ai/images${task === "generate" ? "" : "/edit"}`,
      { method: "POST", headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": crypto.randomUUID() }, body },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error_code: "aiModelDoesNotSupportRequest" });
    expect(state.aiJobs.size).toBe(0);
    expect(state.creditTransactions).toHaveLength(0);
    expect(generateImage).not.toHaveBeenCalled();
    expect(editImage).not.toHaveBeenCalled();
  });
});
