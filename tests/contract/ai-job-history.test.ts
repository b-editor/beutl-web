import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import {
  createAiJob,
  createFile,
  deleteFileWithStorageCleanup,
  findFileForApi,
  findFileForContentAccess,
  retrieveFilesByIdsAndUserId,
  retrieveStorageFilesByUserId,
  prepareAiJobDeletionByUserId,
  setDbProvider,
  StorageCleanupBusyError,
  updateFileVisibility,
  upsertSubscription,
} from "@beutl/db";
import {
  createReservedAiJob,
  reconcileAiJobs,
  parseReplayableAiJobInput,
  setR2BucketProvider,
  v3,
} from "@beutl/api";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const USER_ID = "ai-history-user";
const OTHER_USER_ID = "ai-history-other-user";
const JWT_SECRET = "test-secret-for-ai-history";
const PUBLIC_ORIGIN = "https://beutl.beditor.net";
const ACTIVE_PERIOD = {
  start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000),
  end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
};

function makeApp() {
  return new Hono().basePath("/api/v3").route("/", v3);
}

async function authHeaders(userId = USER_ID) {
  const token = await sign(
    {
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier":
        userId,
      exp: Math.floor(Date.now() / 1000) + 300,
    },
    JWT_SECRET,
    "HS256",
  );
  return { Authorization: `Bearer ${token}` };
}

describe("v3 AI job history contract", () => {
  let prisma: ReturnType<typeof createInMemoryPrisma>["prisma"];
  let state: ReturnType<typeof createInMemoryPrisma>["state"];
  let deleteObject: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const memory = createInMemoryPrisma();
    prisma = memory.prisma;
    state = memory.state;
    setDbProvider(async () => prisma as never);
    deleteObject = vi.fn().mockResolvedValue(undefined);
    setR2BucketProvider(() => ({
      put: vi.fn().mockResolvedValue(undefined),
      delete: deleteObject,
    }));
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.PUBLIC_ORIGIN = PUBLIC_ORIGIN;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.JWT_SECRET;
    delete process.env.PUBLIC_ORIGIN;
  });

  async function seedJob({
    userId = USER_ID,
    kind,
    status = "succeeded",
    inputParams,
    usageUnits = 20,
    createdAt,
    resultFileId = null,
    error = null,
  }: {
    userId?: string;
    kind: string;
    status?: string;
    inputParams?: object;
    usageUnits?: number;
    createdAt: Date;
    resultFileId?: string | null;
    error?: string | null;
  }) {
    const created = await createAiJob({
      userId,
      kind,
      provider: "openrouter",
      status,
      inputParams,
      usageUnits,
    });
    const job = state.aiJobs.get(created.id);
    if (!job) throw new Error("Seeded AI job was not retained");
    Object.assign(job, {
      status,
      resultFileId,
      error,
      createdAt,
      updatedAt: new Date(createdAt.getTime() + 1_000),
    });
    return job;
  }

  it("requires authentication for list, detail, and deletion", async () => {
    const id = crypto.randomUUID();
    for (const [method, path] of [
      ["GET", "/api/v3/ai/jobs"],
      ["GET", `/api/v3/ai/jobs/${id}`],
      ["DELETE", `/api/v3/ai/jobs/${id}`],
    ] as const) {
      const response = await makeApp().request(path, { method });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        error_code: "authenticationIsRequired",
      });
    }
  });

  it("lists only owned, non-deleted jobs newest-first with a stable cursor", async () => {
    const file = await createFile({
      userId: USER_ID,
      name: "result.mp4",
      objectKey: "ai/video/history-result",
      size: 4,
      mimeType: "video/mp4",
      visibility: "PRIVATE",
    });
    const oldest = await seedJob({
      kind: "image",
      inputParams: {
        prompt: "oldest",
        size: "1024x1024",
        providerSecret: "must-not-leak",
      },
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    const middle = await seedJob({
      kind: "stt",
      inputParams: { filename: "speech.wav", durationSeconds: 30 },
      createdAt: new Date("2026-08-02T00:00:00.000Z"),
    });
    const newest = await seedJob({
      kind: "video",
      inputParams: {
        prompt: "newest",
        durationSeconds: 4,
        resolution: "720p",
      },
      usageUnits: 160,
      createdAt: new Date("2026-08-03T00:00:00.000Z"),
      resultFileId: file.id,
    });
    await seedJob({
      userId: OTHER_USER_ID,
      kind: "video",
      inputParams: {
        prompt: "other user",
        durationSeconds: 4,
        resolution: "720p",
      },
      createdAt: new Date("2026-08-05T00:00:00.000Z"),
    });
    const deleted = await seedJob({
      kind: "image",
      inputParams: { prompt: "deleted", size: "1024x1024" },
      createdAt: new Date("2026-08-04T00:00:00.000Z"),
    });
    deleted.deletedAt = new Date("2026-08-06T00:00:00.000Z");

    const firstResponse = await makeApp().request(
      "/api/v3/ai/jobs?limit=2",
      { headers: await authHeaders() },
    );
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json();
    expect(first).toEqual({
      jobs: [
        {
          id: newest.id,
          kind: "video",
          status: "succeeded",
          // Jobs created before an operation could offer more than one model
          // report none rather than guessing at the one they ran on.
          model: null,
          inputParams: {
            prompt: "newest",
            durationSeconds: 4,
            resolution: "720p",
            aspectRatio: "16:9",
            generateAudio: true,
          },
          fileId: file.id,
          url: `${PUBLIC_ORIGIN}/api/contents/${file.id}`,
          fileName: "result.mp4",
          contentType: "video/mp4",
          error: null,
          canRetry: true,
          createdAt: newest.createdAt.toISOString(),
          updatedAt: newest.updatedAt.toISOString(),
        },
        {
          id: middle.id,
          kind: "stt",
          status: "succeeded",
          model: null,
          inputParams: {
            durationSeconds: 30,
          },
          fileId: null,
          url: null,
          fileName: null,
          contentType: null,
          error: null,
          canRetry: false,
          createdAt: middle.createdAt.toISOString(),
          updatedAt: middle.updatedAt.toISOString(),
        },
      ],
      nextCursor: expect.any(String),
    });

    const secondResponse = await makeApp().request(
      `/api/v3/ai/jobs?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
      { headers: await authHeaders() },
    );
    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json();
    expect(second).toEqual({
      jobs: [
        {
          id: oldest.id,
          kind: "image",
          status: "succeeded",
          model: null,
          inputParams: { prompt: "oldest", size: "1024x1024" },
          fileId: null,
          url: null,
          fileName: null,
          contentType: null,
          error: null,
          canRetry: false,
          createdAt: oldest.createdAt.toISOString(),
          updatedAt: oldest.updatedAt.toISOString(),
        },
      ],
      nextCursor: null,
    });
  });

  it("uses replay validation for unknown fields, legacy video defaults, and image shape XOR", async () => {
    const providerSecret = await seedJob({
      kind: "image",
      inputParams: {
        prompt: "secret-bearing image",
        size: "1024x1024",
        providerSecret: "must-not-be-replayed",
      },
      createdAt: new Date("2026-08-07T00:00:00.000Z"),
    });
    const unknownVideoField = await seedJob({
      kind: "video",
      inputParams: {
        prompt: "unknown video field",
        durationSeconds: 4,
        resolution: "720p",
        unexpected: true,
      },
      createdAt: new Date("2026-08-08T00:00:00.000Z"),
    });
    const legacyVideo = await seedJob({
      kind: "video",
      inputParams: { prompt: "legacy video" },
      createdAt: new Date("2026-08-09T00:00:00.000Z"),
    });
    const bothImageShapes = await seedJob({
      kind: "image",
      inputParams: {
        prompt: "ambiguous image",
        size: "1024x1024",
        aspectRatio: "1:1",
      },
      createdAt: new Date("2026-08-10T00:00:00.000Z"),
    });

    const response = await makeApp().request(
      "/api/v3/ai/jobs?limit=100",
      { headers: await authHeaders() },
    );
    expect(response.status).toBe(200);
    const { jobs } = await response.json();
    const byId = new Map(jobs.map((job: { id: string }) => [job.id, job]));

    expect(byId.get(providerSecret.id)).toMatchObject({ canRetry: false });
    expect(byId.get(unknownVideoField.id)).toMatchObject({ canRetry: false });
    // Rows from before duration/resolution were persisted still represent a
    // replayable text-to-video request; the retry action supplies its defaults.
    expect(byId.get(legacyVideo.id)).toMatchObject({
      canRetry: true,
      inputParams: {
        prompt: "legacy video",
        durationSeconds: 4,
        resolution: "720p",
        aspectRatio: "16:9",
        generateAudio: true,
      },
    });
    expect(byId.get(bothImageShapes.id)).toMatchObject({ canRetry: false });
  });

  it("preserves the persisted prompt and body values while adding only legacy video defaults", () => {
    const result = parseReplayableAiJobInput("video", {
      prompt: "keep  internal whitespace",
      seed: 12,
    });
    expect(result).toEqual({
      success: true,
      data: {
        prompt: "keep  internal whitespace",
        seed: 12,
        durationSeconds: 4,
        resolution: "720p",
        aspectRatio: "16:9",
        generateAudio: true,
      },
    });
    expect(parseReplayableAiJobInput("image", { prompt: "keep  internal", size: "1024x1024" })).toEqual({
      success: true,
      data: { prompt: "keep  internal", size: "1024x1024" },
    });
    expect(parseReplayableAiJobInput("image", { prompt: " raw ", size: "1024x1024" }))
      .toEqual({ success: false });
    expect(parseReplayableAiJobInput("video", { prompt: " raw " })).toEqual({ success: false });
  });

  it("uses the job id as a cursor tie-breaker for identical timestamps", async () => {
    const createdAt = new Date("2026-08-03T00:00:00.000Z");
    const jobs = await Promise.all(
      ["first", "second", "third"].map((prompt) =>
        seedJob({
          kind: "image",
          inputParams: { prompt, size: "1024x1024" },
          createdAt,
        }),
      ),
    );
    const expectedIds = jobs
      .map((job) => job.id)
      .sort((left, right) => (left === right ? 0 : left < right ? 1 : -1));

    const firstResponse = await makeApp().request(
      "/api/v3/ai/jobs?limit=2",
      { headers: await authHeaders() },
    );
    const first = await firstResponse.json();
    expect(first.jobs.map((job: { id: string }) => job.id)).toEqual(
      expectedIds.slice(0, 2),
    );

    const secondResponse = await makeApp().request(
      `/api/v3/ai/jobs?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
      { headers: await authHeaders() },
    );
    const second = await secondResponse.json();
    expect(second.jobs.map((job: { id: string }) => job.id)).toEqual(
      expectedIds.slice(2),
    );
    expect(second.nextCursor).toBeNull();
  });

  it("returns the exact detail shape and hides other users and deleted jobs", async () => {
    const job = await seedJob({
      kind: "image",
      status: "failed",
      inputParams: { prompt: "retry me", size: "invalid-size" },
      error: "provider failed with private upstream detail",
      createdAt: new Date("2026-08-03T12:00:00.000Z"),
    });

    const response = await makeApp().request(`/api/v3/ai/jobs/${job.id}`, {
      headers: await authHeaders(),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: job.id,
      kind: "image",
      status: "failed",
      inputParams: null,
      model: null,
      fileId: null,
      url: null,
      fileName: null,
      contentType: null,
      error: "aiProviderError",
      canRetry: false,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    });

    const otherResponse = await makeApp().request(
      `/api/v3/ai/jobs/${job.id}`,
      { headers: await authHeaders(OTHER_USER_ID) },
    );
    expect(otherResponse.status).toBe(404);
    expect(await otherResponse.json()).toMatchObject({
      error_code: "aiJobNotFound",
    });

    job.deletedAt = new Date();
    const deletedResponse = await makeApp().request(
      `/api/v3/ai/jobs/${job.id}`,
      { headers: await authHeaders() },
    );
    expect(deletedResponse.status).toBe(404);
  });

  it("does not offer a text-only retry for a video that used source frames", async () => {
    const job = await seedJob({
      kind: "video",
      status: "failed",
      inputParams: {
        prompt: "Animate this frame",
        durationSeconds: 4,
        resolution: "720p",
        firstFrame: { filename: "private.png", mimeType: "image/png" },
      },
      createdAt: new Date("2026-08-03T12:00:00.000Z"),
    });

    const response = await makeApp().request(`/api/v3/ai/jobs/${job.id}`, {
      headers: await authHeaders(),
    });

    expect(response.status).toBe(200);
    // The frames the video was conditioned on are shown, so the history does
    // not read as a plain text-to-video job — while retry stays closed, because
    // the images themselves were never kept.
    expect(await response.json()).toMatchObject({
      inputParams: {
        prompt: "Animate this frame",
        durationSeconds: 4,
        resolution: "720p",
        firstFrame: { filename: "private.png", mimeType: "image/png" },
      },
      canRetry: false,
    });
  });

  it("still offers a retry for a text-only video", async () => {
    const job = await seedJob({
      kind: "video",
      status: "failed",
      inputParams: {
        prompt: "A calm sea",
        durationSeconds: 4,
        resolution: "720p",
      },
      createdAt: new Date("2026-08-03T13:00:00.000Z"),
    });

    const response = await makeApp().request(`/api/v3/ai/jobs/${job.id}`, {
      headers: await authHeaders(),
    });

    expect(await response.json()).toMatchObject({ canRetry: true });
  });

  it("rejects malformed pagination and job identifiers", async () => {
    const headers = await authHeaders();
    for (const path of [
      "/api/v3/ai/jobs?limit=0",
      "/api/v3/ai/jobs?limit=101",
      "/api/v3/ai/jobs?cursor=not-a-valid-cursor",
      "/api/v3/ai/jobs/not-a-uuid",
    ]) {
      const response = await makeApp().request(path, { headers });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error_code: "invalidRequestBody",
      });
    }
  });

  it("rejects active jobs and does not reveal ownership on deletion", async () => {
    const active = await seedJob({
      kind: "video",
      status: "running",
      inputParams: {
        prompt: "still running",
        durationSeconds: 4,
        resolution: "720p",
      },
      createdAt: new Date("2026-08-03T00:00:00.000Z"),
    });

    const activeResponse = await makeApp().request(
      `/api/v3/ai/jobs/${active.id}`,
      { method: "DELETE", headers: await authHeaders() },
    );
    expect(activeResponse.status).toBe(409);
    expect(await activeResponse.json()).toMatchObject({
      error_code: "aiJobIsActive",
    });
    expect(active.deletedAt).toBeNull();
    expect(deleteObject).not.toHaveBeenCalled();

    active.status = "failed";
    const otherResponse = await makeApp().request(
      `/api/v3/ai/jobs/${active.id}`,
      { method: "DELETE", headers: await authHeaders(OTHER_USER_ID) },
    );
    expect(otherResponse.status).toBe(404);
    expect(active.deletedAt).toBeNull();
  });

  it("keeps AI-owned outputs private and outside ordinary storage operations", async () => {
    const file = await createFile({
      userId: USER_ID,
      name: "legacy-public-result.png",
      objectKey: "ai/images/legacy-public-result",
      size: 4,
      mimeType: "image/png",
      visibility: "PUBLIC",
    });
    await seedJob({
      kind: "image",
      inputParams: { prompt: "legacy", size: "1024x1024" },
      createdAt: new Date("2026-08-03T00:00:00.000Z"),
      resultFileId: file.id,
    });

    expect(await findFileForApi({ id: file.id })).toMatchObject({
      id: file.id,
      visibility: "PRIVATE",
    });
    expect(await findFileForContentAccess({ id: file.id })).toMatchObject({
      visibility: "PRIVATE",
    });
    expect(
      await retrieveStorageFilesByUserId({ userId: USER_ID }),
    ).toEqual([]);
    expect(
      await retrieveFilesByIdsAndUserId({
        ids: [file.id],
        userId: USER_ID,
      }),
    ).toEqual([]);
    await expect(
      updateFileVisibility({ fileId: file.id, visibility: "PUBLIC" }),
    ).rejects.toThrow("owned by an AI job");
    await expect(deleteFileWithStorageCleanup({ fileId: file.id })).rejects.toThrow();
    expect(state.files.has(file.id)).toBe(true);

    const anonymous = await makeApp().request(`/api/v3/files/${file.id}`);
    expect(anonymous.status).toBe(404);
  });

  it("deletes a legacy PUBLIC AI output from both File and R2", async () => {
    const file = await createFile({
      userId: USER_ID,
      name: "public-result.png",
      objectKey: "ai/images/public-result",
      size: 4,
      mimeType: "image/png",
      visibility: "PUBLIC",
    });
    const job = await seedJob({
      kind: "image",
      inputParams: { prompt: "delete public", size: "1024x1024" },
      createdAt: new Date("2026-08-03T00:00:00.000Z"),
      resultFileId: file.id,
    });

    const response = await makeApp().request(`/api/v3/ai/jobs/${job.id}`, {
      method: "DELETE",
      headers: await authHeaders(),
    });

    expect(response.status).toBe(200);
    expect(deleteObject).toHaveBeenCalledWith("ai/images/public-result");
    expect(state.files.has(file.id)).toBe(false);
    expect(state.aiJobs.get(job.id)?.resultFileId).toBeNull();
    expect(state.aiStorageCleanups.size).toBe(0);
  });

  it("deletes the job but preserves an output reused by package content", async () => {
    const file = await createFile({
      userId: USER_ID,
      name: "shared-result.png",
      objectKey: "ai/images/shared-result",
      size: 4,
      mimeType: "image/png",
      visibility: "PRIVATE",
    });
    const job = await seedJob({
      kind: "image",
      inputParams: { prompt: "shared", size: "1024x1024" },
      createdAt: new Date("2026-08-03T00:00:00.000Z"),
      resultFileId: file.id,
    });
    const findFile = prisma.file.findFirst.bind(prisma.file);
    vi.spyOn(prisma.file, "findFirst").mockImplementation(async (args) => {
      const output = await findFile(args);
      return output
        ? { ...output, Package: [{ id: "package-1" }] }
        : null;
    });

    const response = await makeApp().request(`/api/v3/ai/jobs/${job.id}`, {
      method: "DELETE",
      headers: await authHeaders(),
    });

    expect(response.status).toBe(200);
    expect(deleteObject).not.toHaveBeenCalled();
    expect(state.files.has(file.id)).toBe(true);
    expect(state.aiJobs.get(job.id)).toMatchObject({
      resultFileId: null,
      deletedAt: expect.any(Date),
    });
    expect(state.aiStorageCleanups.size).toBe(0);
  });

  it("removes an expired cleanup claim before detaching a shared output", async () => {
    const file = await createFile({
      userId: USER_ID,
      name: "shared-expired-claim.png",
      objectKey: "ai/images/shared-expired-claim",
      size: 4,
      mimeType: "image/png",
      visibility: "PRIVATE",
    });
    const job = await seedJob({
      kind: "image",
      inputParams: { prompt: "shared expired claim", size: "1024x1024" },
      createdAt: new Date("2026-08-03T00:00:00.000Z"),
      resultFileId: file.id,
    });
    const expiredAt = new Date(Date.now() - 1_000);
    state.aiStorageCleanups.set(file.objectKey, {
      objectKey: file.objectKey,
      aiJobId: job.id,
      uploadId: null,
      leaseToken: "expired-cleanup-claim",
      state: "cleanup",
      notBefore: expiredAt,
      createdAt: expiredAt,
      updatedAt: expiredAt,
    });
    const findFile = prisma.file.findFirst.bind(prisma.file);
    vi.spyOn(prisma.file, "findFirst").mockImplementation(async (args) => {
      const output = await findFile(args);
      return output
        ? { ...output, Package: [{ id: "package-1" }] }
        : null;
    });

    const response = await makeApp().request(`/api/v3/ai/jobs/${job.id}`, {
      method: "DELETE",
      headers: await authHeaders(),
    });

    expect(response.status).toBe(200);
    expect(state.files.has(file.id)).toBe(true);
    expect(state.aiJobs.get(job.id)?.resultFileId).toBeNull();
    expect(state.aiStorageCleanups.has(file.objectKey)).toBe(false);

    await expect(
      reconcileAiJobs(new Date(Date.now() + 10 * 60 * 1000)),
    ).resolves.toMatchObject({
      cleanupInspected: 0,
      cleanupDeleted: 0,
      cleanupErrors: 0,
    });
    expect(deleteObject).not.toHaveBeenCalled();
    expect(state.files.has(file.id)).toBe(true);
  });

  it("keeps a shared output attached while its cleanup lease is fresh", async () => {
    const file = await createFile({
      userId: USER_ID,
      name: "shared-active-claim.png",
      objectKey: "ai/images/shared-active-claim",
      size: 4,
      mimeType: "image/png",
      visibility: "PRIVATE",
    });
    const job = await seedJob({
      kind: "image",
      inputParams: { prompt: "shared active claim", size: "1024x1024" },
      createdAt: new Date("2026-08-03T00:00:00.000Z"),
      resultFileId: file.id,
    });
    const leaseExpiresAt = new Date(Date.now() + 60_000);
    state.aiStorageCleanups.set(file.objectKey, {
      objectKey: file.objectKey,
      aiJobId: job.id,
      uploadId: null,
      leaseToken: "active-cleanup-claim",
      state: "cleanup",
      notBefore: leaseExpiresAt,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const findFile = prisma.file.findFirst.bind(prisma.file);
    vi.spyOn(prisma.file, "findFirst").mockImplementation(async (args) => {
      const output = await findFile(args);
      return output
        ? { ...output, Package: [{ id: "package-1" }] }
        : null;
    });

    await expect(
      prepareAiJobDeletionByUserId({ userId: USER_ID, jobId: job.id }),
    ).rejects.toBeInstanceOf(StorageCleanupBusyError);

    expect(state.aiJobs.get(job.id)).toMatchObject({
      resultFileId: file.id,
      deletedAt: null,
    });
    expect(state.aiStorageCleanups.get(file.objectKey)).toMatchObject({
      leaseToken: "active-cleanup-claim",
      notBefore: leaseExpiresAt,
    });
    expect(deleteObject).not.toHaveBeenCalled();
    expect(state.files.has(file.id)).toBe(true);
  });

  it("scrubs and hides the job while retaining cleanup metadata when object deletion fails", async () => {
    const file = await createFile({
      userId: USER_ID,
      name: "result.png",
      objectKey: "ai/images/retry-delete",
      size: 4,
      mimeType: "image/png",
      visibility: "PRIVATE",
    });
    const job = await seedJob({
      kind: "image",
      inputParams: { prompt: "keep metadata", size: "1024x1024" },
      createdAt: new Date("2026-08-03T00:00:00.000Z"),
      resultFileId: file.id,
    });
    deleteObject.mockRejectedValueOnce(new Error("R2 unavailable"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const response = await makeApp().request(`/api/v3/ai/jobs/${job.id}`, {
      method: "DELETE",
      headers: await authHeaders(),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error_code: "unknown" });
    expect(state.files.has(file.id)).toBe(true);
    expect(state.aiStorageCleanups.size).toBe(1);
    expect(state.aiJobs.get(job.id)).toMatchObject({
      resultFileId: file.id,
      inputParams: null,
      error: null,
      deletedAt: expect.any(Date),
    });
    const hidden = await makeApp().request(`/api/v3/ai/jobs/${job.id}`, {
      headers: await authHeaders(),
    });
    expect(hidden.status).toBe(404);

    const reconciliation = await reconcileAiJobs(
      new Date(Date.now() + 1_000),
    );
    expect(reconciliation).toMatchObject({
      cleanupInspected: 1,
      cleanupDeleted: 1,
      cleanupErrors: 0,
    });
    expect(state.files.has(file.id)).toBe(false);
    expect(state.aiJobs.get(job.id)?.resultFileId).toBeNull();
    expect(state.aiStorageCleanups.size).toBe(0);

    const retry = await makeApp().request(`/api/v3/ai/jobs/${job.id}`, {
      method: "DELETE",
      headers: await authHeaders(),
    });
    expect(retry.status).toBe(200);
    consoleError.mockRestore();
  });

  it("soft-deletes the job and private output while retaining the usage ledger", async () => {
    await upsertSubscription({
      userId: USER_ID,
      stripeSubscriptionId: "sub_ai_history",
      status: "active",
      planId: "pro",
      billingOfferId: "offer_pro_test",
      currentPeriodStart: ACTIVE_PERIOD.start,
      currentPeriodEnd: ACTIVE_PERIOD.end,
    });
    const reservation = await createReservedAiJob({
      userId: USER_ID,
      kind: "image",
      provider: "openrouter",
      status: "running",
      inputParams: { prompt: "private result", size: "1024x1024" },
      usageUnits: 20,
    });
    if (!reservation.ok) throw new Error("AI job reservation failed");

    const file = await createFile({
      userId: USER_ID,
      name: "result.png",
      objectKey: "ai/images/private-result",
      size: 4,
      mimeType: "image/png",
      visibility: "PRIVATE",
    });
    const job = state.aiJobs.get(reservation.job.id);
    if (!job) throw new Error("Reserved AI job was not retained");
    job.status = "succeeded";
    job.resultFileId = file.id;
    job.providerJobId = "provider-secret";
    job.error = "old provider detail";
    const ledgerBefore = state.creditTransactions.map((transaction) => ({
      ...transaction,
    }));

    const response = await makeApp().request(
      `/api/v3/ai/jobs/${reservation.job.id}`,
      { method: "DELETE", headers: await authHeaders() },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect(deleteObject).toHaveBeenCalledOnce();
    expect(deleteObject).toHaveBeenCalledWith("ai/images/private-result");
    expect(state.files.has(file.id)).toBe(false);
    expect(state.aiJobs.has(job.id)).toBe(true);
    const deletedJob = state.aiJobs.get(job.id);
    expect(deletedJob).toMatchObject({
      id: reservation.job.id,
      status: "succeeded",
      usageUnits: 20,
      inputParams: null,
      error: null,
      providerJobId: null,
      idempotencyKeyHash: reservation.job.idempotencyKeyHash,
      requestFingerprint: reservation.job.requestFingerprint,
      callbackNonceHash: null,
      resultFileId: null,
      deletedAt: expect.any(Date),
    });
    expect(state.creditTransactions).toEqual(ledgerBefore);
    expect(
      state.creditTransactions.some(
        (transaction) =>
          transaction.aiJobId === reservation.job.id &&
          transaction.kind === "usage",
      ),
    ).toBe(true);
    expect(state.creditAccounts.get(USER_ID)?.monthlyUsageUsed).toBe(20);

    const detail = await makeApp().request(
      `/api/v3/ai/jobs/${reservation.job.id}`,
      {
        headers: await authHeaders(),
      },
    );
    expect(detail.status).toBe(404);
    const list = await makeApp().request("/api/v3/ai/jobs", {
      headers: await authHeaders(),
    });
    expect(await list.json()).toEqual({ jobs: [], nextCursor: null });

    const repeated = await makeApp().request(
      `/api/v3/ai/jobs/${reservation.job.id}`,
      {
        method: "DELETE",
        headers: await authHeaders(),
      },
    );
    expect(repeated.status).toBe(200);
    expect(deleteObject).toHaveBeenCalledOnce();
  });

  it("retains an idempotency tombstone when a job is deleted", async () => {
    await upsertSubscription({
      userId: USER_ID,
      stripeSubscriptionId: "sub_ai_idempotency_delete",
      status: "active",
      planId: "pro",
      billingOfferId: "offer_pro_test",
      currentPeriodStart: ACTIVE_PERIOD.start,
      currentPeriodEnd: ACTIVE_PERIOD.end,
    });
    const identity = {
      idempotencyKeyHash: "a".repeat(64),
      requestFingerprint: "b".repeat(64),
    };
    const first = await createReservedAiJob({
      userId: USER_ID,
      kind: "image",
      provider: "openrouter",
      status: "running",
      usageUnits: 20,
      ...identity,
    });
    if (!first.ok) throw new Error("AI job reservation failed");
    state.aiJobs.get(first.job.id)!.status = "failed";

    const deleted = await makeApp().request(
      `/api/v3/ai/jobs/${first.job.id}`,
      { method: "DELETE", headers: await authHeaders() },
    );
    expect(deleted.status).toBe(200);

    const second = await createReservedAiJob({
      userId: USER_ID,
      kind: "image",
      provider: "openrouter",
      status: "running",
      usageUnits: 20,
      ...identity,
    });
    expect(second).toEqual({
      ok: false,
      errorCode: "aiRequestWasDeleted",
      status: 409,
    });
    expect(state.aiJobs.size).toBe(1);
    expect(state.aiJobs.get(first.job.id)).toMatchObject({
      status: "failed",
      idempotencyKeyHash: identity.idempotencyKeyHash,
      requestFingerprint: identity.requestFingerprint,
      deletedAt: expect.any(Date),
    });
    expect(
      state.creditTransactions.filter(transaction => transaction.kind === "usage"),
    ).toHaveLength(1);
  });
});
