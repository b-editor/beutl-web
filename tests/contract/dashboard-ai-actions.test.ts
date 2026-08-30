import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";
import { setDbProvider } from "@beutl/db";
import { setR2BucketProvider } from "@beutl/api";

// The dashboard AI server actions call @beutl/api shared logic directly.
// Mock the provider layer so the actions can be exercised without a real
// database or R2 bucket.
vi.mock("@/lib/auth-guard", () => ({
  throwIfUnauth: vi.fn(async () => ({
    session: { id: "session-1" },
    user: { id: "user-1", email: "user@example.com" },
  })),
}));
vi.mock("@beutl/next/language", () => ({
  getLanguage: vi.fn(async () => "en"),
}));
vi.mock("@beutl/i18n", () => ({
  getTranslation: vi.fn(async () => ({
    t: (key: string) => key,
  })),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ "x-url": "https://beutl.example/dashboard/ai" })),
}));
vi.mock("@/lib/content-url", () => ({
  getContentUrl: vi.fn(async (id?: string | null) =>
    id ? `https://beutl.example/api/contents/${id}` : null,
  ),
}));

import {
  createVideoAction,
  generateImageAction,
  listJobsAction,
  retryJobAction,
  translateAction,
} from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/ai/actions";
import { aiFailureResult } from "../../apps/web/src/lib/ai-screen";
import {
  createReservedAiJob,
  generateImage,
  readAiJsonResult,
  saveAiImage,
  translateSegments,
} from "@beutl/api";
import {
  createAiJob,
  getAiJobById,
  getAiJobResultFile,
  upsertAiOperationModel,
} from "@beutl/db";

const loadAiImageModelCapabilities = vi.hoisted(() =>
  vi.fn(async () => new Map()),
);

vi.mock("@beutl/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@beutl/api")>();
  return {
    ...actual,
    generateImage: vi.fn(),
    saveAiImage: vi.fn(),
    createReservedAiJob: vi.fn(),
    listAiJobsByUserId: vi.fn(),
    translateSegments: vi.fn(),
    readAiJsonResult: vi.fn(),
    loadAiImageModelCapabilities,
  };
});

vi.mock("@beutl/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@beutl/db")>();
  return { ...actual, getAiJobResultFile: vi.fn() };
});

const PNG_BYTES = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

describe("dashboard AI actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
    setR2BucketProvider(() => ({
      put: vi.fn(async () => ({})),
      delete: vi.fn(async () => undefined),
    }));
    loadAiImageModelCapabilities.mockReset();
    loadAiImageModelCapabilities.mockResolvedValue(new Map());
  });

  // Every submission carries the key that makes a resubmission land on the job
  // the first arrival created instead of reserving and charging again.
  function pngFile(name: string): File {
    return new File([PNG_BYTES.slice()], name, { type: "image/png" });
  }

  function generateForm(prompt = "a cat"): FormData {
    const formData = new FormData();
    formData.set("prompt", prompt);
    formData.set("size", "1024x1024");
    formData.set("idempotencyKey", "3f1a0d0e-0000-4000-8000-000000000001");
    return formData;
  }

  // 終わりのフレームだけの依頼は v3 /videos/frames もエディタの DTO も断る。
  // 入口によって受ける形が変わると、こちらから送ったぶんだけ、予約して課金して
  // から断られる。
  it("refuses a last frame with no first frame, as the API does", async () => {
    const formData = new FormData();
    formData.set("prompt", "Animate the scene");
    formData.set("durationSeconds", "4");
    formData.set("resolution", "720p");
    formData.set("aspectRatio", "16:9");
    formData.set("idempotencyKey", "3f1a0d0e-0000-4000-8000-000000000009");
    formData.set("lastFrame", pngFile("last.png"));

    const result = await createVideoAction({ success: false }, formData);

    expect(result.success).toBe(false);
    expect(result.message).toContain("invalidRequestBody");
    expect(vi.mocked(createReservedAiJob)).not.toHaveBeenCalled();
  });

  it("rejects an empty prompt", async () => {
    const formData = generateForm("  ");
    const result = await generateImageAction({ success: false }, formData);
    expect(result.success).toBe(false);
    expect(result.message).toContain("invalidRequestBody");
  });

  it("refuses a submission that carries no idempotency key", async () => {
    const formData = generateForm();
    formData.delete("idempotencyKey");

    const result = await generateImageAction({ success: false }, formData);

    expect(result.success).toBe(false);
    expect(result.message).toContain("invalidRequestBody");
    // Nothing may be reserved for a request that cannot be recognized on its
    // way back in.
    expect(createReservedAiJob).not.toHaveBeenCalled();
  });

  it("reports plan-required when the reservation is rejected", async () => {
    vi.mocked(createReservedAiJob).mockResolvedValue({
      ok: false,
      errorCode: "aiPlanRequired",
      status: 402,
    });
    const result = await generateImageAction({ success: false }, generateForm());
    expect(result.success).toBe(false);
    expect(result.message).toContain("aiPlanRequired");
  });

  it.each([
    "aiRequestChanged",
    "aiRequestInProgress",
    "aiResultUnavailable",
    "aiRequestInterrupted",
  ])("retains the idempotency key for recoverable reservation error %s", (errorCode) => {
    const result = aiFailureResult(errorCode, (key) => key);
    expect(result).toEqual({
      success: false,
      message: `api-errors:${errorCode}`,
      keepIdempotencyKey: true,
    });
  });

  it.each([
    "doNotHavePermissions",
    "aiPlanRequired",
    "aiJobLimitReached",
    "aiRequestWasDeleted",
    "aiUsageLimitExceeded",
    "aiProviderError",
  ])("clears the idempotency key for terminal reservation error %s", (errorCode) => {
    const result = aiFailureResult(errorCode, (key) => key);
    expect(result).toEqual({
      success: false,
      message: `api-errors:${errorCode}`,
    });
  });

  it("returns the generated image URL on success", async () => {
    vi.mocked(createReservedAiJob).mockResolvedValue({
      ok: true,
      outcome: "reserved",
      job: {
        id: "job-1",
        status: "running",
        resultFileId: null,
        resultFile: null,
      },
    });
    vi.mocked(generateImage).mockResolvedValue({
      b64Json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      mediaType: "image/png",
    });
    vi.mocked(saveAiImage).mockResolvedValue({
      id: "file-1",
      name: "ai-image-job-1.png",
      mimeType: "image/png",
    });
    const result = await generateImageAction({ success: false }, generateForm());
    if (!result.success) {
      throw new Error(`generateImageAction failed: ${result.message}`);
    }
    expect(result.jobId).toBe("job-1");
    expect(result.url).toContain("/api/contents/file-1");
    expect(createReservedAiJob).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKeyHash: expect.any(String),
        requestFingerprint: expect.any(String),
      }),
    );
  });

  it("derives the same identity for a resubmission and a different one for a new prompt", async () => {
    vi.mocked(createReservedAiJob).mockResolvedValue({
      ok: true,
      outcome: "reserved",
      job: { id: "job-1", status: "running", resultFileId: null, resultFile: null },
    });
    vi.mocked(generateImage).mockResolvedValue({
      b64Json:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      mediaType: "image/png",
    });
    vi.mocked(saveAiImage).mockResolvedValue({
      id: "file-1",
      name: "ai-image-job-1.png",
      mimeType: "image/png",
    });

    await generateImageAction({ success: false }, generateForm());
    await generateImageAction({ success: false }, generateForm());
    await generateImageAction({ success: false }, generateForm("a dog"));

    const [first, second, third] = vi
      .mocked(createReservedAiJob)
      .mock.calls.map(([args]) => args);
    expect(second.idempotencyKeyHash).toBe(first.idempotencyKeyHash);
    expect(second.requestFingerprint).toBe(first.requestFingerprint);
    // Same key, different content: the reservation layer answers this with a
    // conflict rather than charging for the second prompt.
    expect(third.requestFingerprint).not.toBe(first.requestFingerprint);
  });

  it("retains a key after a parallel body conflict and replays without a second provider call", async () => {
    vi.mocked(createReservedAiJob)
      .mockResolvedValueOnce({
        ok: true,
        outcome: "reserved",
        job: { id: "job-1", status: "running", resultFileId: null, resultFile: null },
      })
      .mockResolvedValueOnce({
        ok: false,
        errorCode: "aiRequestChanged",
        status: 409,
      })
      .mockResolvedValueOnce({
        ok: true,
        outcome: "existing",
        job: {
          id: "job-1",
          status: "succeeded",
          resultFileId: "file-1",
          resultFile: { name: "result.png", mimeType: "image/png" },
        },
      });
    vi.mocked(generateImage).mockResolvedValue({
      b64Json:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      mediaType: "image/png",
    });
    vi.mocked(saveAiImage).mockResolvedValue({
      id: "file-1",
      name: "ai-image-job-1.png",
      mimeType: "image/png",
    });

    const first = await generateImageAction({ success: false }, generateForm());
    const conflict = await generateImageAction({ success: false }, generateForm("a dog"));
    const replay = await generateImageAction({ success: false }, generateForm());

    expect(first.success).toBe(true);
    expect(conflict).toMatchObject({
      success: false,
      message: "api-errors:aiRequestChanged",
      keepIdempotencyKey: true,
    });
    expect(replay).toMatchObject({ success: true, jobId: "job-1" });
    expect(generateImage).toHaveBeenCalledTimes(1);
    const calls = vi.mocked(createReservedAiJob).mock.calls;
    expect(calls[1]![0].idempotencyKeyHash).toBe(calls[0]![0].idempotencyKeyHash);
    expect(calls[2]![0].idempotencyKeyHash).toBe(calls[0]![0].idempotencyKeyHash);
    expect(calls[1]![0].requestFingerprint).not.toBe(calls[0]![0].requestFingerprint);
  });

  describe("a resubmission of a finished request", () => {
    function translateForm(): FormData {
      const formData = new FormData();
      formData.set("targetLanguage", "en");
      formData.set(
        "segments",
        JSON.stringify([
          { id: "1", text: "こんにちは" },
          { id: "2", text: "さようなら" },
        ]),
      );
      formData.set("idempotencyKey", "3f1a0d0e-0000-4000-8000-000000000002");
      return formData;
    }

    it("answers with the result the first submission paid for", async () => {
      vi.mocked(createReservedAiJob).mockResolvedValue({
        ok: true,
        outcome: "existing",
        job: { id: "job-9", status: "succeeded", resultFileId: "file-9" },
      });
      vi.mocked(getAiJobResultFile).mockResolvedValue({
        id: "file-9",
        objectKey: "ai/text/job-9/result",
      } as never);
      vi.mocked(readAiJsonResult).mockResolvedValue({
        version: 1,
        kind: "translation",
        targetLanguage: "en",
        segments: [
          { id: "1", text: "Hello" },
          { id: "2", text: "Goodbye" },
        ],
      });

      const result = await translateAction({ success: false }, translateForm());

      // Returning only a URL left the screen blank: the editor renders segments.
      expect(result.success).toBe(true);
      expect(result.segments).toEqual([
        { id: "1", text: "Hello" },
        { id: "2", text: "Goodbye" },
      ]);
      // The provider must not be called again for work already charged for.
      expect(translateSegments).not.toHaveBeenCalled();
    });

    it("reports a failure rather than an empty screen when the stored result does not match", async () => {
      vi.mocked(createReservedAiJob).mockResolvedValue({
        ok: true,
        outcome: "existing",
        job: { id: "job-9", status: "succeeded", resultFileId: "file-9" },
      });
      vi.mocked(getAiJobResultFile).mockResolvedValue({
        id: "file-9",
        objectKey: "ai/text/job-9/result",
      } as never);
      vi.mocked(readAiJsonResult).mockResolvedValue({
        version: 1,
        kind: "translation",
        segments: [{ id: "1", text: "Hello" }],
      });

      const result = await translateAction({ success: false }, translateForm());

      expect(result.success).toBe(false);
      // 支払い済みの結果を読み出せなかっただけ。返金済みの失敗として返すと、
      // フォームは名前を捨て、次の送信が新規課金になる。
      expect(result.message).toContain("aiResultUnavailable");
      expect(result.keepIdempotencyKey).toBe(true);
    });
  });

  // The provider answers one translation per ID, so a repeat can never be
  // matched back and the request could not have succeeded. Caught after the
  // call, the user is refunded but the operator has already paid for it.
  it("refuses a repeated segment id before reserving or calling the provider", async () => {
    const formData = new FormData();
    formData.set("targetLanguage", "en");
    formData.set(
      "segments",
      JSON.stringify([
        { id: "1", text: "こんにちは" },
        { id: "1", text: "さようなら" },
      ]),
    );
    formData.set("idempotencyKey", "3f1a0d0e-0000-4000-8000-000000000003");

    const result = await translateAction({ success: false }, formData);

    expect(result.success).toBe(false);
    expect(result.message).toContain("invalidRequestBody");
    expect(createReservedAiJob).not.toHaveBeenCalled();
    expect(translateSegments).not.toHaveBeenCalled();
  });

  it("lists jobs for the signed-in user", async () => {
    const memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
    memory.state.aiJobs.set("job-1", {
      id: "job-1",
      userId: "user-1",
      kind: "image",
      provider: "openrouter",
      providerJobId: null,
      idempotencyKeyHash: null,
      requestFingerprint: null,
      callbackNonceHash: null,
      status: "succeeded",
      inputParams: { prompt: "a cat", size: "1024x1024" },
      usageUnits: 20,
      error: null,
      resultFileId: "file-1",
      providerPollLeaseExpiresAt: null,
      finalizationToken: null,
      finalizationLeaseExpiresAt: null,
      createdAt: new Date("2026-08-16T00:00:00.000Z"),
      updatedAt: new Date("2026-08-16T00:00:00.000Z"),
      deletedAt: null,
    });
    const result = await listJobsAction();
    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs?.[0]).toMatchObject({
      id: "job-1",
      kind: "image",
      status: "succeeded",
      canRetry: true,
    });
  });

  it("hides retry for invalid or unknown persisted fields", async () => {
    const memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
    const base = {
      userId: "user-1", provider: "openrouter", providerJobId: null,
      idempotencyKeyHash: null, requestFingerprint: null, callbackNonceHash: null,
      status: "failed", usageUnits: 20, error: null, resultFileId: null,
      providerPollLeaseExpiresAt: null, finalizationToken: null,
      finalizationLeaseExpiresAt: null, deletedAt: null,
      createdAt: new Date("2026-08-16T00:00:00.000Z"),
      updatedAt: new Date("2026-08-16T00:00:00.000Z"),
    } as const;
    memory.state.aiJobs.set("invalid", {
      ...base, id: "invalid", kind: "image",
      inputParams: { prompt: "a cat", aspectRatio: "future", size: "1024x1024" },
    });
    memory.state.aiJobs.set("unknown", {
      ...base, id: "unknown", kind: "video",
      inputParams: { prompt: "a cat", durationSeconds: 4, unexpected: true },
    });
    const result = await listJobsAction();
    expect(result.jobs?.find((job) => job.id === "invalid")).toMatchObject({ canRetry: false });
    expect(result.jobs?.find((job) => job.id === "unknown")).toMatchObject({ canRetry: false });
  });

  describe("rerunning a job", () => {
    async function registerImageModels(dearIsEnabled: boolean) {
      await upsertAiOperationModel({
        operation: "image.generate",
        modelId: "cheap/model",
        priceUnits: 6,
        displayName: null,
        sortOrder: 0,
        enabled: true,
        updatedBy: "admin-1",
      });
      await upsertAiOperationModel({
        operation: "image.generate",
        modelId: "dear/model",
        priceUnits: 44,
        displayName: null,
        sortOrder: 1,
        enabled: dearIsEnabled,
        updatedBy: "admin-1",
      });
    }

    async function registerVideoModel() {
      await upsertAiOperationModel({
        operation: "video.generate",
        modelId: "dear/video",
        priceUnits: 8,
        displayName: null,
        sortOrder: 0,
        enabled: true,
        updatedBy: "admin-1",
      });
    }

    async function seedFailedImageJob() {
      return await createAiJob({
        userId: "user-1",
        kind: "image",
        provider: "openrouter",
        status: "failed",
        inputParams: { prompt: "a cat", aspectRatio: "1:1" },
        usageUnits: 44,
        model: "dear/model",
      });
    }

    it("repeats the model the original ran on", async () => {
      await registerImageModels(true);
      const job = await seedFailedImageJob();
      vi.mocked(createReservedAiJob).mockResolvedValue({
        ok: true,
        outcome: "reserved",
        job: { id: "job-retry", status: "running", resultFileId: null, resultFile: null },
      });
      vi.mocked(generateImage).mockResolvedValue({
        b64Json:
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        mediaType: "image/png",
      });
      vi.mocked(saveAiImage).mockResolvedValue({
        id: "file-retry",
        name: "ai-image-job-retry.png",
        mimeType: "image/png",
      });

      const result = await retryJobAction(
        job.id,
        "3f1a0d0e-0000-4000-8000-000000000010",
      );

      expect(result.success).toBe(true);
      // Not the default, which is cheaper and would produce a different picture.
      expect(createReservedAiJob).toHaveBeenCalledWith(
        expect.objectContaining({ model: "dear/model", usageUnits: 44 }),
      );
      expect(generateImage).toHaveBeenCalledWith(
        expect.objectContaining({ model: "dear/model" }),
      );
    });

    it("validates without trimming the persisted retry prompt", async () => {
      await registerImageModels(true);
      const job = await createAiJob({
        userId: "user-1",
        kind: "image",
        provider: "openrouter",
        status: "failed",
        inputParams: { prompt: "  a cat  ", aspectRatio: "1:1" },
        usageUnits: 44,
        model: "dear/model",
      });
      vi.mocked(createReservedAiJob).mockResolvedValue({
        ok: true,
        outcome: "reserved",
        job: { id: "job-spaced", status: "running", resultFileId: null, resultFile: null },
      });
      vi.mocked(generateImage).mockResolvedValue({
        b64Json:
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        mediaType: "image/png",
      });
      vi.mocked(saveAiImage).mockResolvedValue({
        id: "file-spaced",
        name: "spaced.png",
        mimeType: "image/png",
      });

      const result = await retryJobAction(job.id, crypto.randomUUID());

      expect(result.success).toBe(true);
      expect(createReservedAiJob).toHaveBeenCalledWith(
        expect.objectContaining({
          inputParams: expect.objectContaining({ prompt: "  a cat  " }),
        }),
      );
      expect(generateImage).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "  a cat  " }),
      );
    });

    it("recovers a succeeded existing retry reservation instead of reporting provider error", async () => {
      await registerImageModels(true);
      const job = await seedFailedImageJob();
      vi.mocked(createReservedAiJob).mockResolvedValue({
        ok: true,
        outcome: "existing",
        job: {
          id: "job-existing-retry",
          status: "succeeded",
          resultFileId: "file-existing-retry",
          resultFile: { name: "result.png", mimeType: "image/png" },
        },
      });

      const result = await retryJobAction(
        job.id,
        "3f1a0d0e-0000-4000-8000-000000000014",
      );

      expect(result).toMatchObject({
        success: true,
        jobId: "job-existing-retry",
        fileName: "result.png",
        contentType: "image/png",
      });
      expect(generateImage).not.toHaveBeenCalled();
    });

    it("refuses when that model has since been disabled", async () => {
      await registerImageModels(false);
      const job = await seedFailedImageJob();

      const result = await retryJobAction(
        job.id,
        "3f1a0d0e-0000-4000-8000-000000000011",
      );

      // Quietly rerunning on the default would charge the default's price for
      // a model the user never chose.
      expect(result.success).toBe(false);
      expect(result.message).toContain("aiModelUnavailable");
      expect(createReservedAiJob).not.toHaveBeenCalled();
      expect(generateImage).not.toHaveBeenCalled();
    });

    it("refuses a retry whose current image capability no longer supports its request", async () => {
      await registerImageModels(true);
      const job = await createAiJob({
        userId: "user-1",
        kind: "image",
        provider: "openrouter",
        status: "failed",
        inputParams: {
          prompt: "a cat",
          aspectRatio: "1:1",
          background: "transparent",
          seed: 7,
        },
        usageUnits: 44,
        model: "dear/model",
      });
      loadAiImageModelCapabilities.mockResolvedValue(new Map([
        ["dear/model", {
          modelId: "dear/model",
          aspectRatios: ["2:3"],
          backgrounds: ["auto", "opaque"],
          seed: false,
          inputReferences: false,
          maxReferenceImages: 0,
          resolution: false,
        }],
      ]));

      const result = await retryJobAction(
        job.id,
        "3f1a0d0e-0000-4000-8000-000000000015",
      );

      expect(result).toMatchObject({
        success: false,
        message: "api-errors:aiModelDoesNotSupportRequest",
      });
      expect(createReservedAiJob).not.toHaveBeenCalled();
      expect(generateImage).not.toHaveBeenCalled();
    });

    it.each([
      {
        request: { aspectRatio: "1:1" },
        capabilities: {
          aspectRatios: ["2:3"],
          backgrounds: ["auto", "opaque", "transparent"],
          seed: true,
        },
      },
      {
        request: { aspectRatio: "1:1", background: "transparent" },
        capabilities: {
          aspectRatios: ["1:1"],
          backgrounds: ["auto", "opaque"],
          seed: true,
        },
      },
      {
        request: { aspectRatio: "1:1", seed: 7 },
        capabilities: {
          aspectRatios: ["1:1"],
          backgrounds: ["auto", "opaque", "transparent"],
          seed: false,
        },
      },
    ] as const)(
      "rejects a retry when its current image capability is withdrawn (%j)",
      async ({ request, capabilities }) => {
        await registerImageModels(true);
        const job = await createAiJob({
          userId: "user-1",
          kind: "image",
          provider: "openrouter",
          status: "failed",
          inputParams: { prompt: "a cat", ...request },
          usageUnits: 44,
          model: "dear/model",
        });
        loadAiImageModelCapabilities.mockResolvedValue(new Map([
          ["dear/model", {
            modelId: "dear/model",
            ...capabilities,
            inputReferences: false,
            maxReferenceImages: 0,
            resolution: false,
          }],
        ]));

        const result = await retryJobAction(job.id, crypto.randomUUID());

        expect(result).toMatchObject({
          success: false,
          message: "api-errors:aiModelDoesNotSupportRequest",
        });
        expect(createReservedAiJob).not.toHaveBeenCalled();
        expect(generateImage).not.toHaveBeenCalled();
      },
    );

    it("does not normalize an unknown persisted background into a paid auto retry", async () => {
      await registerImageModels(true);
      const job = await createAiJob({
        userId: "user-1",
        kind: "image",
        provider: "openrouter",
        status: "failed",
        inputParams: { prompt: "a cat", aspectRatio: "1:1", background: "future-mode" },
        usageUnits: 44,
        model: "dear/model",
      });

      const result = await retryJobAction(
        job.id,
        "3f1a0d0e-0000-4000-8000-000000000016",
      );

      expect(result).toMatchObject({
        success: false,
        message: "api-errors:invalidRequestBody",
      });
      expect(createReservedAiJob).not.toHaveBeenCalled();
      expect(generateImage).not.toHaveBeenCalled();
    });

    it.each(["not-a-seed", -1, 1.5])(
      "rejects an invalid persisted image seed (%s) before reserve/provider",
      async (seed) => {
        await registerImageModels(true);
        const job = await createAiJob({
          userId: "user-1", kind: "image", provider: "openrouter", status: "failed",
          inputParams: { prompt: "a cat", aspectRatio: "1:1", seed },
          usageUnits: 44, model: "dear/model",
        });
        const result = await retryJobAction(job.id, crypto.randomUUID());
        expect(result).toMatchObject({ success: false, message: "api-errors:invalidRequestBody" });
        expect(createReservedAiJob).not.toHaveBeenCalled();
        expect(generateImage).not.toHaveBeenCalled();
      },
    );

    it.each([
      { reference: { filename: "legacy.png" } },
      {
        references: [
          { filename: "first.png" },
          { filename: "second.png" },
        ],
      },
    ])("refuses image retries that contain stored reference metadata (%j) before reserving", async (referenceFields) => {
      await registerImageModels(true);
      const job = await createAiJob({
        userId: "user-1",
        kind: "image",
        provider: "openrouter",
        status: "failed",
        inputParams: {
          prompt: "a cat",
          aspectRatio: "1:1",
          ...referenceFields,
        },
        usageUnits: 44,
        model: "dear/model",
      });

      const result = await retryJobAction(
        job.id,
        "3f1a0d0e-0000-4000-8000-000000000012",
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain("invalidRequestBody");
      expect(createReservedAiJob).not.toHaveBeenCalled();
      expect(generateImage).not.toHaveBeenCalled();
    });

    it.each([
      ["reference", null],
      ["reference", false],
      ["reference", ""],
      ["references", null],
      ["references", false],
      ["references", ""],
      ["references", 0],
    ] as const)(
      "rejects a present malformed image reference field (%s=%j) before reservation",
      async (field, value) => {
        await registerImageModels(true);
        const inputParams: Record<string, unknown> = {
          prompt: "a cat",
          aspectRatio: "1:1",
          [field]: value,
        };
        const job = await createAiJob({
          userId: "user-1",
          kind: "image",
          provider: "openrouter",
          status: "failed",
          inputParams,
          usageUnits: 44,
          model: "dear/model",
        });

        const result = await retryJobAction(job.id, crypto.randomUUID());

        expect(result).toMatchObject({
          success: false,
          message: "api-errors:invalidRequestBody",
        });
        expect(createReservedAiJob).not.toHaveBeenCalled();
        expect(generateImage).not.toHaveBeenCalled();
      },
    );

    it("does not fall back to legacy size when aspectRatio is present but malformed", async () => {
      await registerImageModels(true);
      const job = await createAiJob({
        userId: "user-1",
        kind: "image",
        provider: "openrouter",
        status: "failed",
        inputParams: {
          prompt: "a cat",
          aspectRatio: null,
          size: "1024x1024",
        },
        usageUnits: 44,
        model: "dear/model",
      });

      const result = await retryJobAction(job.id, crypto.randomUUID());

      expect(result).toMatchObject({
        success: false,
        message: "api-errors:invalidRequestBody",
      });
      expect(createReservedAiJob).not.toHaveBeenCalled();
      expect(generateImage).not.toHaveBeenCalled();
    });

    it.each(["not-a-seed", -1, 1.5])(
      "rejects an invalid persisted video seed (%s) before reserve/provider",
      async (seed) => {
        await registerVideoModel();
        const job = await createAiJob({
          userId: "user-1", kind: "video", provider: "openrouter", status: "failed",
          inputParams: {
            prompt: "a cat", durationSeconds: 4, resolution: "720p", aspectRatio: "16:9", seed,
          },
          usageUnits: 32, model: "dear/video",
        });
        const result = await retryJobAction(job.id, crypto.randomUUID());
        expect(result).toMatchObject({ success: false, message: "api-errors:invalidRequestBody" });
        expect(createReservedAiJob).not.toHaveBeenCalled();
      },
    );

    it.each([
      ["durationSeconds", "4"], ["durationSeconds", 4.5], ["durationSeconds", null],
      ["resolution", 123], ["resolution", null], ["resolution", "bad"],
      ["aspectRatio", 123], ["aspectRatio", null], ["aspectRatio", "bad"],
      ["generateAudio", "false"], ["generateAudio", 0], ["generateAudio", null],
      ["firstFrame", null], ["firstFrame", false], ["firstFrame", {}],
      ["lastFrame", null], ["lastFrame", false], ["lastFrame", {}],
    ] as const)("rejects present malformed video field %s before reservation", async (field, value) => {
      await registerVideoModel();
      const inputParams: Record<string, unknown> = {
        prompt: "a cat", durationSeconds: 4, resolution: "720p", aspectRatio: "16:9",
      };
      inputParams[field] = value;
      const job = await createAiJob({
        userId: "user-1", kind: "video", provider: "openrouter", status: "failed",
        inputParams, usageUnits: 32, model: "dear/video",
      });
      const result = await retryJobAction(job.id, crypto.randomUUID());
      expect(result).toMatchObject({ success: false, message: "api-errors:invalidRequestBody" });
      expect(createReservedAiJob).not.toHaveBeenCalled();
    });

    it("rejects a retry when the confirmed job payload changed before reservation", async () => {
      await registerImageModels(true);
      const job = await seedFailedImageJob();
      const expectedPayload = JSON.stringify({
        kind: "image",
        model: "dear/model",
        inputParams: { prompt: "a cat", aspectRatio: "1:1" },
      });
      const stored = (await getAiJobById({ jobId: job.id })) as { inputParams: Record<string, unknown> };
      stored.inputParams.prompt = "a dog";

      const result = await retryJobAction(
        job.id,
        "3f1a0d0e-0000-4000-8000-000000000013",
        expectedPayload,
      );

      expect(result).toMatchObject({
        success: false,
        message: "api-errors:aiRequestChanged",
        keepIdempotencyKey: true,
      });
      expect(createReservedAiJob).not.toHaveBeenCalled();
    });
  });
});
