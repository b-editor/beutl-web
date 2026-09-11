import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

vi.mock("server-only", () => ({}));
const getContext = vi.hoisted(() => vi.fn());

let copyAiResultToStorage: typeof import("../../apps/web/src/lib/storage").copyAiResultToStorage;

beforeAll(async () => {
  const requireFromWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));
  vi.doMock(requireFromWeb.resolve("@opennextjs/cloudflare"), () => ({ getCloudflareContext: getContext }));
  ({ copyAiResultToStorage } = await import("../../apps/web/src/lib/storage"));
});

import { setDbProvider } from "@beutl/db";
import { setR2BucketProvider } from "@beutl/api";
import { STORAGE_FREE_FILE_COUNT_LIMIT } from "@beutl/core";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const RESULT_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

// A copy in storage is a second object: the job's own result must survive the
// copy being deleted, and the copy must survive the job being deleted.
describe("keeping an AI result in storage", () => {
  let memory: ReturnType<typeof createInMemoryPrisma>;
  let objects: Map<string, Uint8Array>;
  let bucket: {
    put: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    head: ReturnType<typeof vi.fn>;
  };

  function seedResult({
    jobId = "job-1",
    fileId = "result-1",
    userId = "u",
    mimeType = "image/png",
    name = `ai-image-${jobId}.png`,
    deletedAt = null as Date | null,
  } = {}) {
    objects.set(`ai/image/${jobId}/object`, RESULT_BYTES);
    memory.state.files.set(fileId, {
      id: fileId,
      userId,
      objectKey: `ai/image/${jobId}/object`,
      name,
      size: RESULT_BYTES.byteLength,
      mimeType,
      visibility: "PRIVATE",
      sha256: "abc",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    memory.state.aiJobs.set(jobId, {
      id: jobId,
      userId,
      kind: "image",
      provider: "test",
      providerJobId: null,
      idempotencyKeyHash: null,
      requestFingerprint: null,
      callbackNonceHash: null,
      status: "succeeded",
      inputParams: null,
      model: null,
      resultFileId: fileId,
      usageUnits: 1,
      error: null,
      providerPollLeaseExpiresAt: null,
      finalizationToken: null,
      finalizationLeaseExpiresAt: null,
      deletedAt,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    memory = createInMemoryPrisma();
    objects = new Map();
    bucket = {
      put: vi.fn(async (key: string, value: ArrayBuffer) => {
        objects.set(key, new Uint8Array(value));
      }),
      get: vi.fn(async (key: string) => {
        const bytes = objects.get(key);
        if (!bytes) return null;
        return {
          size: bytes.byteLength,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
        };
      }),
      delete: vi.fn(async (key: string) => {
        objects.delete(key);
      }),
      head: vi.fn(async (key: string) => {
        const bytes = objects.get(key);
        return bytes ? { size: bytes.byteLength } : null;
      }),
    };
    setDbProvider(async () => memory.prisma as never);
    setR2BucketProvider(() => bucket as never);
    getContext.mockReturnValue({
      env: { BEUTL_R2_BUCKET: bucket },
      ctx: { waitUntil: () => undefined },
    });
  });

  it("copies the result under a new key as a private storage file", async () => {
    seedResult();

    const outcome = await copyAiResultToStorage({ jobId: "job-1", userId: "u" });

    expect(outcome.kind).toBe("created");
    if (outcome.kind !== "created") return;
    const copy = memory.state.files.get(outcome.record.id);
    expect(copy).toMatchObject({
      userId: "u",
      name: "ai-image-job-1.png",
      mimeType: "image/png",
      visibility: "PRIVATE",
    });
    expect(Number(copy?.size)).toBe(RESULT_BYTES.byteLength);
    expect(copy?.objectKey).not.toBe("ai/image/job-1/object");
    expect(objects.get(copy!.objectKey)).toEqual(RESULT_BYTES);
    // The job's own result is untouched, and the copy is not the job's result.
    expect(objects.get("ai/image/job-1/object")).toEqual(RESULT_BYTES);
    expect(memory.state.aiJobs.get("job-1")?.resultFileId).toBe("result-1");
    expect(memory.state.files.size).toBe(2);
    // Reservation consumed, no write outbox left behind.
    expect([...memory.state.storageUploads.values()][0]).toMatchObject({
      reservationKind: "dedicated",
      completedFileId: outcome.record.id,
    });
    expect(memory.state.aiStorageCleanups.size).toBe(0);
  });

  it("refuses the copy when the storage quota is full without reading the result", async () => {
    seedResult();
    for (let index = 0; index < STORAGE_FREE_FILE_COUNT_LIMIT; index++) {
      memory.state.files.set(`f-${index}`, {
        id: `f-${index}`,
        userId: "u",
        objectKey: `f-${index}`,
        name: `f-${index}.bin`,
        size: 1,
        mimeType: "application/octet-stream",
        visibility: "PRIVATE",
        sha256: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    await expect(
      copyAiResultToStorage({ jobId: "job-1", userId: "u" }),
    ).resolves.toEqual({ kind: "tooManyFiles" });
    expect(bucket.get).not.toHaveBeenCalled();
    expect(bucket.put).not.toHaveBeenCalled();
    expect(memory.state.storageUploads.size).toBe(0);
  });

  it("gives the copy a free name when the storage already holds one", async () => {
    seedResult();
    memory.state.files.set("taken", {
      id: "taken",
      userId: "u",
      objectKey: "taken",
      name: "ai-image-job-1.png",
      size: 1,
      mimeType: "image/png",
      visibility: "PRIVATE",
      sha256: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const outcome = await copyAiResultToStorage({ jobId: "job-1", userId: "u" });

    expect(outcome).toMatchObject({
      kind: "created",
      record: { name: "ai-image-job-1 (1).png" },
    });
  });

  it("lands in the chosen folder when it is the user's", async () => {
    seedResult();
    memory.state.storageFolders.set("folder-1", {
      id: "folder-1", name: "Renders", userId: "u", parentId: null, createdAt: new Date(),
    });

    const outcome = await copyAiResultToStorage({
      jobId: "job-1", userId: "u", folderId: "folder-1",
    });

    expect(outcome.kind).toBe("created");
    if (outcome.kind !== "created") return;
    expect(memory.state.files.get(outcome.record.id)?.folderId).toBe("folder-1");
  });

  it("refuses another user's folder before reserving or writing anything", async () => {
    seedResult();
    memory.state.storageFolders.set("theirs", {
      id: "theirs", name: "Theirs", userId: "someone-else", parentId: null, createdAt: new Date(),
    });

    for (const folderId of ["theirs", "missing"]) {
      await expect(
        copyAiResultToStorage({ jobId: "job-1", userId: "u", folderId }),
      ).resolves.toEqual({ kind: "folderNotFound" });
    }
    expect(bucket.get).not.toHaveBeenCalled();
    expect(bucket.put).not.toHaveBeenCalled();
    expect(memory.state.storageUploads.size).toBe(0);
  });

  it("falls back to the root when the folder vanished before the commit", async () => {
    seedResult();
    memory.state.storageFolders.set("folder-1", {
      id: "folder-1", name: "Renders", userId: "u", parentId: null, createdAt: new Date(),
    });
    // Deleted between the ownership check and the File commit: the folder
    // going away moves what it held to the root, and this copy goes there too.
    bucket.put.mockImplementationOnce(async (key: string, value: ArrayBuffer) => {
      memory.state.storageFolders.delete("folder-1");
      objects.set(key, new Uint8Array(value));
    });

    const outcome = await copyAiResultToStorage({
      jobId: "job-1", userId: "u", folderId: "folder-1",
    });

    expect(outcome.kind).toBe("created");
    if (outcome.kind !== "created") return;
    expect(memory.state.files.get(outcome.record.id)?.folderId).toBeNull();
  });

  it("does not copy another user's result, a deleted job's result, or a transcript", async () => {
    seedResult({ jobId: "other", fileId: "other-file", userId: "someone-else" });
    seedResult({ jobId: "gone", fileId: "gone-file", deletedAt: new Date() });
    seedResult({
      jobId: "transcript",
      fileId: "transcript-file",
      mimeType: "application/json",
      name: "transcript.json",
    });

    for (const jobId of ["other", "gone", "transcript", "missing"]) {
      await expect(
        copyAiResultToStorage({ jobId, userId: "u" }),
      ).resolves.toEqual({ kind: "unavailable" });
    }
    expect(bucket.put).not.toHaveBeenCalled();
    expect(memory.state.storageUploads.size).toBe(0);
  });
});
