import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { getCreditAccount, setDbProvider, upsertAiOperationModel, upsertSubscription } from "@beutl/db";
import { createReservedAiJob, getEntitlements, saveAiImage, setR2BucketProvider, v3 } from "@beutl/api";
import { providerSupportsOperation } from "../../packages/api/src/ai/providers/registry";
import { getAiRequestIdentity, sha256Hex } from "../../packages/api/src/ai/request-integrity";
import { editGatewayImage } from "../../packages/api/src/ai/providers/vercel-gateway/image";
import { editImage } from "../../packages/api/src/ai/openrouter";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

vi.mock("../../packages/api/src/ai/providers/vercel-gateway/image", async (original) => ({
  ...(await original<typeof import("../../packages/api/src/ai/providers/vercel-gateway/image")>()),
  editGatewayImage: vi.fn(),
}));
vi.mock("../../packages/api/src/ai/openrouter", async (original) => ({
  ...(await original<typeof import("../../packages/api/src/ai/openrouter")>()), editImage: vi.fn(),
}));
vi.mock("../../packages/api/src/ai/image-model-capabilities", async (original) => ({
  ...(await original<typeof import("../../packages/api/src/ai/image-model-capabilities")>()),
  loadAiImageModelCapabilities: vi.fn(async () => new Map()),
}));
vi.mock("../../packages/api/src/ai/video-model-capabilities", async (original) => ({
  ...(await original<typeof import("../../packages/api/src/ai/video-model-capabilities")>()),
  loadAiVideoModelCapabilities: vi.fn(async () => new Map()),
}));
vi.mock("../../packages/api/src/ai/model-pricing", async (original) => ({
  ...(await original<typeof import("../../packages/api/src/ai/model-pricing")>()),
  loadAiCostEstimates: vi.fn(async () => ({ entries: [] })),
}));

const userId = "raw-outpaint-user";
const model = "openai/gpt-image-2";
const prompt = "Extend the landscape";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const bytes = Uint8Array.from(Buffer.from(PNG, "base64")).buffer;
const app = () => new Hono<{ Bindings: { AI_IMAGE_PREPARED_OUTPAINT?: boolean } }>()
  .basePath("/api/v3").route("/", v3);

async function headers(key = "outpaint-request") {
  const token = await sign({ "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier": userId, exp: Math.floor(Date.now() / 1000) + 300 }, "outpaint-test-secret", "HS256");
  return { Authorization: `Bearer ${token}`, "Idempotency-Key": key };
}

async function edit(task: string, selectedModel?: string) {
  const form = new FormData();
  form.set("task", task); form.set("prompt", prompt);
  form.set("file", new File([bytes], "source.png", { type: "image/png" }));
  if (selectedModel) form.set("model", selectedModel);
  return app().request("/api/v3/ai/images/edit", { method: "POST", headers: await headers(), body: form });
}

describe("Gateway outpainting is not a raw-image API operation", () => {
  let memory: ReturnType<typeof createInMemoryPrisma>;
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv("JWT_SECRET", "outpaint-test-secret");
    vi.stubEnv("PUBLIC_ORIGIN", "https://beutl.beditor.net");
    memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
    setR2BucketProvider(() => ({ put: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) }));
    vi.mocked(editGatewayImage).mockResolvedValue({ b64Json: PNG, mediaType: "image/png" });
    vi.mocked(editImage).mockResolvedValue({ b64Json: PNG, mediaType: "image/png" });
    await upsertSubscription({ userId, stripeSubscriptionId: "sub_raw_outpaint", status: "active", planId: "pro", billingOfferId: "offer_pro_test", currentPeriodStart: new Date(Date.now() - 86_400_000), currentPeriodEnd: new Date(Date.now() + 86_400_000) });
    for (const operation of ["image.edit.outpaint", "image.edit.restyle"]) {
      await upsertAiOperationModel({ operation, modelId: model, provider: "vercel-gateway", priceUnits: 4, usagePercent: 100, displayName: null, sortOrder: 0, enabled: true, updatedBy: "admin" });
    }
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([undefined, model])("rejects a raw upload before reserving usage (model=%s)", async (selected) => {
    const response = await edit("outpaint", selected);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error_code: "aiModelDoesNotSupportRequest" });
    expect(vi.mocked(editGatewayImage)).not.toHaveBeenCalled();
    expect(memory.state.aiJobs.size).toBe(0);
    expect(memory.state.creditTransactions).toHaveLength(0);
  });

  it("accepts a Web-prepared outpaint canvas only on the trusted internal path", async () => {
    const form = new FormData();
    const preparedPrompt = `Extend the image naturally into the transparent canvas while preserving the original center. ${prompt}`;
    form.set("task", "outpaint");
    form.set("prompt", prompt);
    form.set("outpaintExpansion", "25");
    form.set("model", model);
    form.set("file", new File([bytes], "prepared.png", { type: "image/png" }));

    const response = await app().request(
      "/api/v3/ai/images/edit",
      { method: "POST", headers: await headers("prepared-outpaint"), body: form },
      { AI_IMAGE_PREPARED_OUTPAINT: true },
    );

    expect(response.status).toBe(200);
    expect(vi.mocked(editGatewayImage)).toHaveBeenCalledWith(
      expect.objectContaining({ task: "outpaint", prompt: preparedPrompt }),
    );
    expect(memory.state.aiJobs.size).toBe(1);
    expect([...memory.state.aiJobs.values()][0]?.inputParams).toMatchObject({ outpaintExpansion: 25 });
    expect((await getCreditAccount({ userId })).monthlyUsageUsed).toBeGreaterThan(0);
  });

  it("rejects an invalid prepared expansion before reserving usage", async () => {
    const form = new FormData();
    form.set("task", "outpaint");
    form.set("prompt", prompt);
    form.set("outpaintExpansion", "9");
    form.set("model", model);
    form.set("file", new File([bytes], "prepared.png", { type: "image/png" }));

    const response = await app().request(
      "/api/v3/ai/images/edit",
      { method: "POST", headers: await headers("invalid-prepared-outpaint"), body: form },
      { AI_IMAGE_PREPARED_OUTPAINT: true },
    );

    expect(response.status).toBe(400);
    expect(memory.state.aiJobs.size).toBe(0);
    expect(memory.state.creditTransactions).toHaveLength(0);
  });

  it("does not advertise unsupported API outpainting but keeps Web availability", async () => {
    const response = await app().request("/api/v3/ai/capabilities", { headers: await headers() });
    const capabilities = await response.json();
    expect(capabilities.operations["image.edit.outpaint"].models).toEqual([]);
    const access = await (await app().request("/api/v3/user/entitlements", { headers: await headers() })).json();
    expect(access.availability["image.edit.outpaint"]).toBe(false);
    expect(access.modelAvailability["image.edit.outpaint"]).toEqual({});
    const web = await getEntitlements(userId);
    expect(web.modelAvailability["image.edit.outpaint"][model]).toBe(true);
    expect(providerSupportsOperation("vercel-gateway", "image.edit.outpaint")).toBe(true);
  });

  it("refuses authoritative API availability for raw outpainting", async () => {
    const response = await app().request("/api/v3/user/ai-availability", {
      method: "POST", headers: { ...await headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "image.edit.outpaint", model }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ available: false });
  });

  it("continues to accept Gateway restyling and native OpenRouter outpainting", async () => {
    expect((await edit("restyle", model)).status).toBe(200);
    expect(vi.mocked(editGatewayImage)).toHaveBeenCalledOnce();
    await upsertAiOperationModel({ operation: "image.edit.outpaint", modelId: "openai/gpt-image-1", provider: "openrouter", priceUnits: 4, usagePercent: 100, displayName: null, sortOrder: 1, enabled: true, updatedBy: "admin" });
    // Use a fresh key for the independent edit.
    const form = new FormData();
    form.set("task", "outpaint"); form.set("prompt", prompt); form.set("model", "openai/gpt-image-1");
    form.set("file", new File([bytes], "source.png", { type: "image/png" }));
    expect((await app().request("/api/v3/ai/images/edit", { method: "POST", headers: await headers("native-outpaint"), body: form })).status).toBe(200);
    expect(vi.mocked(editImage)).toHaveBeenCalledWith(expect.objectContaining({ task: "outpaint" }));
    const capabilities = await (await app().request("/api/v3/ai/capabilities", { headers: await headers() })).json();
    expect(capabilities.operations["image.edit.outpaint"].models).toEqual([
      expect.objectContaining({ id: "openai/gpt-image-1", isDefault: false }),
    ]);
  });

  it("still returns a paid result created before raw outpainting was disabled", async () => {
    const identity = await getAiRequestIdentity({
      request: new Request("https://beutl.beditor.net/api/v3/ai/images/edit", { headers: await headers() }),
      operation: "image.edit.outpaint",
      input: { task: "outpaint", model, prompt, fileName: "source.png", contentType: "image/png", contentSha256: await sha256Hex(bytes) },
    });
    if (!identity) throw new Error("Missing fixture identity");
    const reservation = await createReservedAiJob({ userId, kind: "image_edit", provider: "vercel-gateway", status: "running", model, usageUnits: 4, ...identity });
    if (!reservation.ok) throw new Error("Fixture reservation failed");
    const file = await saveAiImage({ userId, jobId: reservation.job.id, bytes, mimeType: "image/png", filename: "paid.png" });
    const response = await edit("outpaint", model);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ jobId: reservation.job.id, fileId: file.id });
    expect(vi.mocked(editGatewayImage)).not.toHaveBeenCalled();
    expect((await getCreditAccount({ userId })).monthlyUsageUsed).toBe(4);
    expect(memory.state.aiJobs.size).toBe(1);
  });
});
