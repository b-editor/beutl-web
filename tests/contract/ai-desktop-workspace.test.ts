import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { sign } from "hono/jwt";

const calls = vi.hoisted(() => ({ jobs: vi.fn(), folders: vi.fn(), save: vi.fn() }));
vi.mock("@beutl/db", async (original) => ({
  ...(await original<typeof import("@beutl/db")>()),
  listAiJobsByUserId: calls.jobs,
  retrieveStorageFoldersByUserId: calls.folders,
}));
vi.mock("../../packages/api/src/storage/files", () => ({
  createStorageOperations: () => ({ copyAiResultToStorage: calls.save }),
}));

import workspace from "../../packages/api/src/v3/ai/workspace";
import { videoReferenceFingerprintLimit } from "../../apps/web/src/lib/ai-video-submit";
import { fileFingerprint } from "../../apps/web/src/lib/ai-screen";

const jobId = "11111111-1111-4111-8111-111111111111";
const key = "22222222-2222-4222-8222-222222222222";
const app = () => new Hono().basePath("/api/v3/ai").route("/", workspace);
async function headers() {
  return {
    Authorization: `Bearer ${await sign(
      {
        "http://schemas.microsoft.com/ws/2008/06/identity/claims/role": "user",
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier": "owner",
        exp: Math.floor(Date.now() / 1000) + 300,
      },
      "workspace-test-secret",
      "HS256",
    )}`,
    "Content-Type": "application/json",
  };
}

describe("AI desktop workspace endpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = "workspace-test-secret";
    calls.jobs.mockResolvedValue({ jobs: [], nextCursor: null });
    calls.folders.mockResolvedValue([]);
    calls.save.mockResolvedValue({
      kind: "created",
      record: { id: "copy", name: "saved.png", folderId: null },
    });
  });
  afterEach(() => {
    delete process.env.JWT_SECRET;
  });

  it("requires authentication before listing or saving", async () => {
    expect((await app().request("/api/v3/ai/source-videos")).status).toBe(404);
    expect((await app().request("/api/v3/ai/storage-folders")).status).toBe(401);
    expect(
      (await app().request(`/api/v3/ai/jobs/${jobId}/storage`, { method: "POST" })).status,
    ).toBe(401);
    expect(calls.jobs).not.toHaveBeenCalled();
    expect(calls.save).not.toHaveBeenCalled();
  });

  it("does not expose generated videos as editing sources", async () => {
    expect((await app().request("/api/v3/ai/source-videos", { headers: await headers() })).status).toBe(404);
    expect(calls.jobs).not.toHaveBeenCalled();
  });

  it("lists only the authenticated owner's folder tree", async () => {
    calls.folders.mockResolvedValue([
      { id: "folder", name: "Assets", parentId: null, privateField: "excluded" },
    ]);
    const response = await app().request("/api/v3/ai/storage-folders", {
      headers: await headers(),
    });
    expect(await response.json()).toEqual({
      folders: [{ id: "folder", name: "Assets", parentId: null }],
    });
    expect(calls.folders).toHaveBeenCalledWith({ userId: "owner" });
  });

  it("passes the unchanged save identity and owner to the shared quota-safe copy operation", async () => {
    for (let index = 0; index < 2; index++) {
      const response = await app().request(`/api/v3/ai/jobs/${jobId}/storage`, {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify({ folderId: null, saveKey: key }),
      });
      expect(response.status).toBe(200);
      expect((await response.json()).kind).toBe("created");
    }
    expect(calls.save).toHaveBeenNthCalledWith(1, {
      jobId,
      userId: "owner",
      folderId: null,
      saveKey: key,
    });
    expect(calls.save).toHaveBeenNthCalledWith(2, {
      jobId,
      userId: "owner",
      folderId: null,
      saveKey: key,
    });
  });

  it("rejects foreign owner overrides and invalid save keys before copying", async () => {
    for (const body of [
      { folderId: null, saveKey: "invalid" },
      { folderId: null, saveKey: key, userId: "other" },
    ]) {
      expect(
        (
          await app().request(`/api/v3/ai/jobs/${jobId}/storage`, {
            method: "POST",
            headers: await headers(),
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(400);
    }
    expect(calls.save).not.toHaveBeenCalled();
  });

  it("keeps capacity and unsettled-save outcomes distinct", async () => {
    for (const kind of [
      "overQuota",
      "tooManyFiles",
      "folderNotFound",
      "inProgress",
      "unavailable",
    ]) {
      calls.save.mockResolvedValue({ kind });
      const response = await app().request(`/api/v3/ai/jobs/${jobId}/storage`, {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify({ folderId: null, saveKey: key }),
      });
      expect(await response.json()).toEqual({ kind });
    }
  });

  it("fingerprints every byte of a valid video reference larger than five MiB", async () => {
    const size = 6 * 1024 * 1024;
    const a = new File([new Uint8Array(size)], "same.mp4", { type: "video/mp4" });
    const b = new File([new Uint8Array(size).fill(1)], "same.mp4", { type: "video/mp4" });
    const first = await fileFingerprint(a, videoReferenceFingerprintLimit(a));
    const second = await fileFingerprint(b, videoReferenceFingerprintLimit(b));
    expect(first).toHaveLength(64);
    expect(second).toHaveLength(64);
    expect(first).not.toBe(second);
  });
});
