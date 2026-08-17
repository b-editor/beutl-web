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
} from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/ai/actions";
import {
  createReservedAiJob,
  generateImage,
  saveAiImage,
} from "@beutl/api";

vi.mock("@beutl/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@beutl/api")>();
  return {
    ...actual,
    generateImage: vi.fn(),
    saveAiImage: vi.fn(),
    createReservedAiJob: vi.fn(),
    listAiJobsByUserId: vi.fn(),
  };
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

  it("rejects an empty prompt", async () => {
    const formData = new FormData();
    formData.set("prompt", "  ");
    formData.set("size", "1024x1024");
    const result = await generateImageAction({ success: false }, formData);
    expect(result.success).toBe(false);
    expect(result.message).toContain("invalidRequestBody");
  });

  it("reports plan-required when the reservation is rejected", async () => {
    vi.mocked(createReservedAiJob).mockResolvedValue({
      ok: false,
      errorCode: "aiPlanRequired",
      status: 402,
    });
    const formData = new FormData();
    formData.set("prompt", "a cat");
    formData.set("size", "1024x1024");
    const result = await generateImageAction({ success: false }, formData);
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
    const formData = new FormData();
    formData.set("prompt", "a cat");
    formData.set("size", "1024x1024");
    const result = await generateImageAction({ success: false }, formData);
    if (!result.success) {
      throw new Error(`generateImageAction failed: ${result.message}`);
    }
    expect(result.jobId).toBe("job-1");
    expect(result.url).toContain("/api/contents/file-1");
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
