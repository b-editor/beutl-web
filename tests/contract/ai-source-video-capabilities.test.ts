import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { consumeUsage, setDbProvider, upsertAiOperationModel, upsertSubscription } from "@beutl/db";
import { aiCapabilityKey, v3 } from "@beutl/api";
import type { AiVideoModelCapabilities } from "../../packages/api/src/ai/video-model-capabilities";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const { submitVideo, inspectVideo, loadCapabilities } = vi.hoisted(() => ({
  submitVideo: vi.fn(),
  inspectVideo: vi.fn(),
  loadCapabilities: vi.fn(),
}));
vi.mock("../../packages/api/src/ai/video-jobs", async (original) => ({
  ...(await original<typeof import("../../packages/api/src/ai/video-jobs")>()),
  createAndAttachVideoJob: submitVideo,
}));
vi.mock("../../packages/api/src/ai/video-validation", async (original) => ({
  ...(await original<typeof import("../../packages/api/src/ai/video-validation")>()),
  inspectGeneratedVideo: inspectVideo,
}));
vi.mock("../../packages/api/src/ai/video-model-capabilities", async (original) => ({
  ...(await original<typeof import("../../packages/api/src/ai/video-model-capabilities")>()),
  loadAiVideoModelCapabilities: loadCapabilities,
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const MODEL_ID = "gateway/source-video";
const JWT_SECRET = "source-video-capabilities-test";
const PERIOD_START = new Date(Date.now() - 86_400_000);
const PERIOD_END = new Date(Date.now() + 30 * 86_400_000);
const MODES = ["edit", "extend", "motion"] as const;
const PNG_BYTES = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
));

function capabilities(): AiVideoModelCapabilities {
  return {
    modelId: MODEL_ID,
    resolutions: ["720p"],
    durations: [5, 8],
    aspectRatios: ["16:9"],
    generateAudio: true,
    seed: false,
    firstFrame: true,
    lastFrame: false,
    promptToVideo: true,
    referenceToVideo: true,
    videoEditing: true,
    videoExtension: true,
    motionControl: true,
    maxInputReferences: 1,
    maxReferenceBytes: 1024,
    maxSourceVideoBytes: 1024,
    minSourceVideoSeconds: 2,
    maxSourceVideoSeconds: 2.2,
    maxPromptCharacters: 500,
    maxVideoReferences: 0,
    maxVideoReferenceBytes: 0,
    maxAudioReferences: 0,
    maxAudioReferenceBytes: 0,
    maxTotalReferences: null,
  };
}

describe("source-video model admission", () => {
  let state: ReturnType<typeof createInMemoryPrisma>["state"];
  let selected: AiVideoModelCapabilities;

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubEnv("JWT_SECRET", JWT_SECRET);
    vi.stubEnv("PUBLIC_ORIGIN", "https://beutl.beditor.net");
    const memory = createInMemoryPrisma();
    state = memory.state;
    setDbProvider(async () => memory.prisma as never);
    selected = capabilities();
    loadCapabilities.mockResolvedValue(new Map([
      [aiCapabilityKey("vercel-gateway", MODEL_ID), selected],
    ]));
    inspectVideo.mockReturnValue({ mimeType: "video/mp4", durationSeconds: 2 });
    await upsertSubscription({
      userId: USER_ID,
      stripeSubscriptionId: "sub_source_limits",
      status: "active",
      planId: "pro",
      billingOfferId: "offer_pro_test",
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: PERIOD_END,
      cancelAt: null,
    });
    for (const mode of [...MODES, "generate"]) {
      await upsertAiOperationModel({
        operation: `video.${mode}`,
        modelId: MODEL_ID,
        provider: "vercel-gateway",
        priceUnits: 40,
        displayName: null,
        sortOrder: 0,
        enabled: true,
        updatedBy: "admin",
      });
    }
  });

  afterEach(() => vi.unstubAllEnvs());

  async function post(path: string, body: FormData, key: string | null = crypto.randomUUID()) {
    const token = await sign({
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier": USER_ID,
      exp: Math.floor(Date.now() / 1000) + 300,
    }, JWT_SECRET, "HS256");
    return new Hono().basePath("/api/v3").route("/", v3).request(
      `/api/v3/ai/videos/${path}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, ...(key === null ? {} : { "Idempotency-Key": key }) },
        body,
      },
    );
  }

  async function submit(mode: typeof MODES[number], key?: string | null) {
    const body = new FormData();
    body.set("prompt", "make it night");
    body.set("model", MODEL_ID);
    body.set("sourceVideo", new File(["clip"], "clip.mp4", { type: "video/mp4" }));
    if (mode !== "edit") body.set("durationSeconds", "5");
    if (mode === "motion") {
      body.set("characterImage", new File([PNG_BYTES], "character.png", { type: "image/png" }));
    }
    return post(mode, body, key);
  }

  async function endPlan() {
    await upsertSubscription({
      userId: USER_ID,
      stripeSubscriptionId: "sub_source_limits",
      status: "canceled",
      planId: "pro",
      billingOfferId: "offer_pro_test",
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: PERIOD_END,
      cancelAt: null,
    });
  }

  describe.each(MODES)("%s upload preflight", (mode) => {
    it.each(["no-plan", "no-credit", "missing-key"])("rejects %s before reading uploads", async (reason) => {
      if (reason === "no-plan") await endPlan();
      if (reason === "no-credit") {
        await consumeUsage({
          userId: USER_ID,
          amount: 500,
          monthlyUsageLimit: 500,
          usagePeriod: { start: PERIOD_START, end: PERIOD_END },
          aiJobId: "exhaust-before-upload",
        });
      }
      const formRead = vi.spyOn(Request.prototype, "formData");
      const fileRead = vi.spyOn(File.prototype, "arrayBuffer");
      try {
        const response = await submit(mode, reason === "missing-key" ? null : undefined);

        expect(response.status).toBe(reason === "missing-key" ? 400 : 409);
        expect(await response.json()).toMatchObject({
          error_code: reason === "missing-key" ? "invalidRequestBody" : "aiRequestInProgress",
        });
        expect(formRead).not.toHaveBeenCalled();
        expect(fileRead).not.toHaveBeenCalled();
        expect(inspectVideo).not.toHaveBeenCalled();
        expect(submitVideo).not.toHaveBeenCalled();
        expect(state.aiJobs.size).toBe(0);
      } finally {
        formRead.mockRestore();
        fileRead.mockRestore();
      }
    });

    it("recovers a paid job after the plan ends without reserving again", async () => {
      const key = `recover-${mode}`;
      const started = await submit(mode, key);
      expect(started.status).toBe(200);
      const original = await started.json();
      const transactionCount = state.creditTransactions.length;
      await endPlan();

      const replay = await submit(mode, key);

      expect(replay.status).toBe(202);
      expect(await replay.json()).toMatchObject({ jobId: original.jobId });
      expect(submitVideo).toHaveBeenCalledOnce();
      expect(state.aiJobs.size).toBe(1);
      expect(state.creditTransactions).toHaveLength(transactionCount);
    });

    it("does not let a settled key bypass upload admission after the plan ends", async () => {
      const key = `settled-${mode}`;
      const started = await submit(mode, key);
      const { jobId } = await started.json();
      const job = state.aiJobs.get(jobId)!;
      state.aiJobs.set(jobId, { ...job, status: "failed" });
      await endPlan();
      const formRead = vi.spyOn(Request.prototype, "formData");
      const fileRead = vi.spyOn(File.prototype, "arrayBuffer");
      try {
        const response = await submit(mode, key);
        expect(response.status).toBe(402);
        expect(await response.json()).toMatchObject({ error_code: "aiPlanRequired" });
        expect(formRead).not.toHaveBeenCalled();
        expect(fileRead).not.toHaveBeenCalled();
        expect(submitVideo).toHaveBeenCalledOnce();
      } finally {
        formRead.mockRestore();
        fileRead.mockRestore();
      }
    });
  });

  async function submitReferences(durations: readonly number[]) {
    selected.maxVideoReferences = 3;
    selected.maxVideoReferenceBytes = 1024;
    const body = new FormData();
    body.set("prompt", "use these clips");
    body.set("model", MODEL_ID);
    body.set("durationSeconds", "5");
    for (const [index, durationSeconds] of durations.entries()) {
      inspectVideo.mockReturnValueOnce({ mimeType: "video/mp4", durationSeconds });
      body.append("reference[]", new File([`clip ${index}`], `${index}.mp4`, { type: "video/mp4" }));
    }
    return post("frames", body);
  }

  describe("generation reference-video durations", () => {
    it.each([
      [1.5, 2.1],
      [2.1, 1.5],
      [2.3, 2.1],
      [2.1, 2.3],
    ])("rejects references of %s and %s seconds before reservation", async (first, second) => {
      const response = await submitReferences([first, second]);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error_code: "aiModelDoesNotSupportRequest" });
      expect(state.aiJobs.size).toBe(0);
      expect(state.creditTransactions).toHaveLength(0);
      expect(submitVideo).not.toHaveBeenCalled();
    });

    it("accepts exact boundaries and fractional durations without rounding", async () => {
      const response = await submitReferences([2, 2.1, 2.2]);

      expect(response.status).toBe(200);
      expect(submitVideo).toHaveBeenCalledWith(expect.objectContaining({
        durationSeconds: 5,
        inputReferences: expect.any(Array),
      }));
      expect([...state.aiJobs.values()]).toEqual([
        expect.objectContaining({ usageUnits: 200 }),
      ]);
    });

    it("allows reference durations when the model publishes no bounds", async () => {
      selected.minSourceVideoSeconds = null;
      selected.maxSourceVideoSeconds = null;
      const response = await submitReferences([1.5, 2.3]);

      expect(response.status).toBe(200);
      expect(submitVideo).toHaveBeenCalledOnce();
    });
  });

  it("rejects a motion character image above the model's byte limit before reservation", async () => {
    selected.maxReferenceBytes = PNG_BYTES.byteLength - 1;
    const response = await submit("motion");

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error_code: "aiModelDoesNotSupportRequest" });
    expect(state.aiJobs.size).toBe(0);
    expect(state.creditTransactions).toHaveLength(0);
    expect(submitVideo).not.toHaveBeenCalled();
  });

  it("accepts a motion character image exactly at the model's byte limit", async () => {
    selected.maxReferenceBytes = PNG_BYTES.byteLength;
    const response = await submit("motion");

    expect(response.status).toBe(200);
    expect(submitVideo).toHaveBeenCalledOnce();
    expect(state.aiJobs.size).toBe(1);
  });

  describe.each(MODES)("%s audio generation", (mode) => {
    it.each([false, true])("uses the model's generateAudio=%s capability", async (generateAudio) => {
      selected.generateAudio = generateAudio;
      const response = await submit(mode);

      expect(response.status).toBe(200);
      expect(submitVideo).toHaveBeenCalledWith(expect.objectContaining({ generateAudio }));
    });

    it("preserves the default when the model publishes no capabilities", async () => {
      loadCapabilities.mockResolvedValue(new Map());
      const response = await submit(mode);

      expect(response.status).toBe(200);
      expect(submitVideo).toHaveBeenCalledWith(expect.objectContaining({ generateAudio: true }));
    });
  });

  describe.each(MODES)("%s source duration", (mode) => {
    it.each([1.5, 2.3])("rejects an out-of-range %s-second source before reservation", async (durationSeconds) => {
      inspectVideo.mockReturnValue({ mimeType: "video/mp4", durationSeconds });
      const response = await submit(mode);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error_code: "aiModelDoesNotSupportRequest" });
      expect(state.aiJobs.size).toBe(0);
      expect(state.creditTransactions).toHaveLength(0);
      expect(submitVideo).not.toHaveBeenCalled();
    });

    it.each([2, 2.1, 2.2])("accepts an in-range %s-second source and bills whole seconds", async (durationSeconds) => {
      inspectVideo.mockReturnValue({ mimeType: "video/mp4", durationSeconds });
      const response = await submit(mode);

      expect(response.status).toBe(200);
      const billedSeconds = mode === "edit" ? Math.ceil(durationSeconds) : 5;
      expect(submitVideo).toHaveBeenCalledWith(expect.objectContaining({ durationSeconds: billedSeconds }));
      expect([...state.aiJobs.values()]).toEqual([
        expect.objectContaining({ usageUnits: billedSeconds * 40 }),
      ]);
    });
  });
});
