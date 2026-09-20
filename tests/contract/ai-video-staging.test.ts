import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { getCreditAccount, setDbProvider, upsertAiOperationModel, upsertSubscription } from "@beutl/db";
import { AiVideoSubmissionError, setR2BucketProvider, v3 } from "@beutl/api";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const startVideo = vi.hoisted(() => vi.fn());
vi.mock("../../packages/api/src/ai/providers/vercel-gateway/video", async (original) => ({
  ...(await original<typeof import("../../packages/api/src/ai/providers/vercel-gateway/video")>()),
  startGatewayVideoJob: startVideo,
}));
vi.mock("../../packages/api/src/ai/video-model-capabilities", async (original) => ({
  ...(await original<typeof import("../../packages/api/src/ai/video-model-capabilities")>()),
  loadAiVideoModelCapabilities: vi.fn(async () => new Map()),
}));
vi.mock("../../packages/api/src/ai/video-validation", async (original) => ({
  ...(await original<typeof import("../../packages/api/src/ai/video-validation")>()),
  inspectGeneratedVideo: vi.fn(() => ({ mimeType: "video/mp4", durationSeconds: 2 })),
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const MODES = ["edit", "extend", "motion", "frames", "references"] as const;

describe("video input staging failures", () => {
  let memory: ReturnType<typeof createInMemoryPrisma>;
  const put = vi.fn();

  beforeEach(async () => {
    memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
    vi.stubEnv("JWT_SECRET", "staging-test-secret");
    vi.stubEnv("PUBLIC_ORIGIN", "https://beutl.beditor.net");
    put.mockReset().mockResolvedValue(undefined);
    startVideo.mockReset().mockResolvedValue({ id: "provider-job", status: "pending" });
    setR2BucketProvider(() => ({ put, delete: vi.fn() }));
    await upsertSubscription({
      userId: USER_ID, stripeSubscriptionId: "sub_staging", status: "active", planId: "pro",
      billingOfferId: "offer_pro_test", currentPeriodStart: new Date(Date.now() - 86_400_000),
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000), cancelAt: null,
    });
    for (const operation of ["video.edit", "video.extend", "video.motion", "video.generate"]) {
      await upsertAiOperationModel({
        operation, modelId: "gateway/model", provider: "vercel-gateway", priceUnits: 10,
        displayName: null, sortOrder: 0, enabled: true, updatedBy: "admin",
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function submit(mode: typeof MODES[number]) {
    const token = await sign({
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier": USER_ID,
      exp: Math.floor(Date.now() / 1000) + 300,
    }, "staging-test-secret", "HS256");
    const body = new FormData();
    body.set("prompt", "move");
    body.set("model", "gateway/model");
    if (mode !== "edit") body.set("durationSeconds", "5");
    if (mode === "frames") body.set("firstFrame", new File([PNG], "frame.png", { type: "image/png" }));
    else if (mode === "references") body.append("reference[]", new File([PNG], "ref.png", { type: "image/png" }));
    else body.set("sourceVideo", new File(["clip"], "source.mp4", { type: "video/mp4" }));
    if (mode === "motion") body.set("characterImage", new File([PNG], "character.png", { type: "image/png" }));
    return new Hono().basePath("/api/v3").route("/", v3).request(
      `/api/v3/ai/videos/${mode === "references" ? "frames" : mode}`,
      { method: "POST", headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": crypto.randomUUID() }, body },
    );
  }

  describe.each(MODES)("%s", (mode) => {
    it.each(["cleanup-registration", "object-write"])("refunds immediately after %s fails", async (failure) => {
      const registration = failure === "cleanup-registration"
        ? vi.spyOn(memory.prisma.aiStorageCleanup, "create").mockRejectedValueOnce(new Error("database unavailable"))
        : null;
      if (failure === "object-write") put.mockRejectedValueOnce(new Error("storage unavailable"));

      const response = await submit(mode);

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error_code: "aiProviderError" });
      expect(startVideo).not.toHaveBeenCalled();
      expect([...memory.state.aiJobs.values()]).toEqual([
        expect.objectContaining({ status: "failed", providerJobId: null }),
      ]);
      expect((await getCreditAccount({ userId: USER_ID })).monthlyUsageUsed).toBe(0);
      expect(memory.state.creditTransactions.filter((row) => row.kind === "refund")).toHaveLength(1);
      registration?.mockRestore();

      // The failed reservation must also release the sole active-video slot.
      expect((await submit(mode)).status).toBe(200);
      expect(startVideo).toHaveBeenCalledOnce();
    });
  });

  it("keeps an uncertain provider start queued after staging succeeded", async () => {
    startVideo.mockRejectedValue(new AiVideoSubmissionError("response lost", { outcome: "unknown" }));
    const response = await submit("motion");

    expect(response.status).toBe(200);
    expect([...memory.state.aiJobs.values()]).toEqual([
      expect.objectContaining({ status: "queued", providerJobId: null }),
    ]);
    expect((await getCreditAccount({ userId: USER_ID })).monthlyUsageUsed).toBe(50);
    expect(memory.state.creditTransactions.filter((row) => row.kind === "refund")).toHaveLength(0);
  });
});
