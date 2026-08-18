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
  generateImageAction,
  listJobsAction,
  translateAction,
} from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/ai/actions";
import {
  createReservedAiJob,
  generateImage,
  readAiJsonResult,
  saveAiImage,
  translateSegments,
} from "@beutl/api";
import { getAiJobResultFile } from "@beutl/db";

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
  };
});

vi.mock("@beutl/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@beutl/db")>();
  return { ...actual, getAiJobResultFile: vi.fn() };
});

describe("dashboard AI actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
    setR2BucketProvider(() => ({
      put: vi.fn(async () => ({})),
      delete: vi.fn(async () => undefined),
    }));
  });

  // Every submission carries the key that makes a resubmission land on the job
  // the first arrival created instead of reserving and charging again.
  function generateForm(prompt = "a cat"): FormData {
    const formData = new FormData();
    formData.set("prompt", prompt);
    formData.set("size", "1024x1024");
    formData.set("idempotencyKey", "3f1a0d0e-0000-4000-8000-000000000001");
    return formData;
  }

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
      expect(result.message).toContain("aiProviderError");
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
    });
  });
});
