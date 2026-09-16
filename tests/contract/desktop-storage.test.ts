import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sign } from "hono/jwt";
import { setDbProvider } from "@beutl/db";
import { api } from "@beutl/api";
import { setR2BucketProvider } from "@beutl/api/ai/r2-provider";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const USER = "desktop-storage-user";
const SECRET = "desktop-storage-contract-test-secret";

describe("storage resource API", () => {
  let memory: ReturnType<typeof createInMemoryPrisma>;
  beforeEach(() => {
    memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
    vi.stubEnv("JWT_SECRET", SECRET);
    vi.stubEnv("JWT_ISSUER", "");
    vi.stubEnv("JWT_AUDIENCE", "");
  });
  afterEach(() => vi.unstubAllEnvs());
  function file(id: string, overrides: Record<string, unknown> = {}) {
    memory.state.files.set(id, {
      id,
      userId: USER,
      objectKey: `private-key/${id}`,
      name: id,
      size: 1024,
      mimeType: "image/png",
      visibility: "PRIVATE",
      sha256: null,
      folderId: null,
      createdAt: new Date("2026-09-01T00:00:00Z"),
      updatedAt: new Date(),
      ...overrides,
    } as never);
  }
  function folder(id: string, userId = USER, parentId: string | null = null, name = id) {
    memory.state.storageFolders.set(id, {
      id,
      userId,
      parentId,
      name,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  async function request(path: string, method = "GET", body?: unknown, userId = USER) {
    const token = await sign(
      {
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier": userId,
        exp: Math.floor(Date.now() / 1000) + 300,
      },
      SECRET,
      "HS256",
    );
    return api.request(`/api/v3/storage${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  it("authorizes every resource before accessing data and disables response caching", async () => {
    const db = vi.fn(async () => memory.prisma as never);
    setDbProvider(db);
    for (const [method, path] of [
      ["GET", "/entries"],
      ["GET", "/usage"],
      ["POST", "/folders"],
      ["PATCH", "/files/x"],
      ["DELETE", "/folders/x"],
      ["POST", "/files/batch"],
    ]) {
      const response = await api.request(`/api/v3/storage${path}`, { method });
      expect(response.status).toBe(401);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Vary")).toBe("Authorization");
    }
    expect(db).not.toHaveBeenCalled();
    expect((await request("/")).status).toBe(404);
  });

  it("returns only immediate owned children and their path, without storage internals or usage queries", async () => {
    folder("parent");
    folder("child", USER, "parent");
    folder("grandchild", USER, "child");
    folder("foreign", "other");
    file("nested", { folderId: "parent", size: 5 * 1024 ** 3 });
    file("root");
    file("foreign-file", { userId: "other" });
    const aggregate = vi.spyOn(memory.prisma.file, "aggregate");
    const body = await (await request("/entries?parentId=parent")).json();
    expect(body.parentId).toBe("parent");
    expect(body.path.map((x: { id: string }) => x.id)).toEqual(["parent"]);
    expect(body.entries.map((x: { id: string }) => x.id)).toEqual(["child", "nested"]);
    expect(body.entries[1]).toMatchObject({
      size: 5 * 1024 ** 3,
      actions: ["open", "download", "rename", "move", "details", "setPublic", "delete"],
    });
    expect(JSON.stringify(body)).not.toMatch(/objectKey|userId|private-key/);
    expect(body).not.toHaveProperty("usage");
    expect(body).not.toHaveProperty("total");
    expect(aggregate).not.toHaveBeenCalled();
    const usage = await (await request("/usage")).json();
    expect(usage.usedBytes).toBe(5 * 1024 ** 3 + 1024);
    expect(aggregate).toHaveBeenCalled();
    expect((await request("/entries?parentId=foreign")).status).toBe(404);
    expect((await request("/entries?parentId=gone")).status).toBe(404);
  });

  it("pages folders then files using an opaque cursor and handles deletion of an earlier entry", async () => {
    for (let i = 0; i < 4; i++) folder(`folder-${i}`, USER, null, "same");
    for (let i = 0; i < 6; i++) file(`file-${i}`, { name: "same" });
    const first = await (await request("/entries?limit=3")).json();
    expect(first.entries).toHaveLength(3);
    expect(first.nextCursor).toEqual(expect.any(String));
    memory.state.storageFolders.delete("folder-0");
    const seen = first.entries.map((x: { id: string }) => x.id);
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await (
        await request(`/entries?limit=3&cursor=${encodeURIComponent(cursor)}`)
      ).json();
      seen.push(...page.entries.map((x: { id: string }) => x.id));
      cursor = page.nextCursor;
    }
    expect(seen).toEqual([
      "folder-0",
      "folder-1",
      "folder-2",
      "folder-3",
      "file-0",
      "file-1",
      "file-2",
      "file-3",
      "file-4",
      "file-5",
    ]);
    expect(new Set(seen).size).toBe(10);
    folder("other-parent");
    expect(
      (await request(`/entries?parentId=other-parent&cursor=${first.nextCursor}`)).status,
    ).toBe(400);
    expect((await request(`/entries?kind=folder&cursor=${first.nextCursor}`)).status).toBe(400);
    const folders = await (await request("/entries?kind=folder&limit=100")).json();
    expect(folders.entries.every((x: { kind: string }) => x.kind === "folder")).toBe(true);
    for (const query of ["limit=0", "limit=101", "cursor=garbage", "parentId=", "sort=oops"])
      expect((await request(`/entries?${query}`)).status).toBe(400);
  });

  it("creates folders and atomically patches names and parents, refusing cycles and foreign targets", async () => {
    folder("parent");
    folder("foreign", "other");
    const created = await request("/folders", "POST", { name: "  Clips  ", parentId: "parent" });
    expect(created.status).toBe(201);
    const { id } = await created.json();
    expect(created.headers.get("Location")).toBe(`/api/v3/storage/folders/${id}`);
    expect(memory.state.storageFolders.get(id)).toMatchObject({
      userId: USER,
      parentId: "parent",
      name: "Clips",
    });
    expect(
      (await request(`/folders/${id}`, "PATCH", { name: "Edited", parentId: null })).status,
    ).toBe(204);
    expect(memory.state.storageFolders.get(id)).toMatchObject({ name: "Edited", parentId: null });
    folder("descendant", USER, id);
    expect(
      (
        await request(`/folders/${id}`, "PATCH", {
          name: "Must not change",
          parentId: "descendant",
        })
      ).status,
    ).toBe(409);
    expect(memory.state.storageFolders.get(id)?.name).toBe("Edited");
    expect((await request(`/folders/${id}`, "PATCH", { parentId: "foreign" })).status).toBe(404);
    expect((await request("/folders/foreign", "PATCH", { name: "bad" })).status).toBe(404);
    for (const name of [" ", "a".repeat(256), "bad\nname"])
      expect((await request("/folders", "POST", { name, parentId: null })).status).toBe(400);
    expect(
      (await request("/folders", "POST", { name: "ok", parentId: null, userId: "other" })).status,
    ).toBe(400);
    expect((await request(`/folders/${id}`, "PATCH", {})).status).toBe(400);
  });

  it("updates an exact file set atomically and enforces dedicated-file actions", async () => {
    file("a");
    file("b");
    file("foreign", { userId: "other" });
    file("dedicated", { visibility: "DEDICATED" });
    folder("target");
    expect(
      (
        await request("/files/a", "PATCH", {
          name: "renamed",
          parentId: "target",
          visibility: "PUBLIC",
        })
      ).status,
    ).toBe(204);
    expect(memory.state.files.get("a")).toMatchObject({
      name: "renamed",
      folderId: "target",
      visibility: "PUBLIC",
    });
    expect(
      (
        await request("/files/batch", "POST", {
          operation: "visibility",
          ids: ["a", "foreign"],
          visibility: "PRIVATE",
        })
      ).status,
    ).toBe(404);
    expect(memory.state.files.get("a")?.visibility).toBe("PUBLIC");
    expect(
      (
        await request("/files/batch", "POST", {
          operation: "visibility",
          ids: ["a", "dedicated"],
          visibility: "PRIVATE",
        })
      ).status,
    ).toBe(409);
    expect(memory.state.files.get("a")?.visibility).toBe("PUBLIC");
    expect((await request("/files/dedicated", "PATCH", { parentId: "target" })).status).toBe(204);
    expect((await request("/files/dedicated", "PATCH", { name: "no" })).status).toBe(409);
    const dedicated = await (await request("/files/dedicated")).json();
    expect(dedicated.actions).toEqual(["open", "download", "move", "details"]);
    const publicFile = await (await request("/files/a")).json();
    expect(publicFile.actions).toContain("copyLink");
    expect(publicFile.contentUrl).toContain("/api/contents/a");
    expect(publicFile).not.toHaveProperty("objectKey");
    expect((await request("/files/foreign")).status).toBe(404);
    expect(
      (
        await request("/files/batch", "POST", {
          operation: "move",
          ids: ["a", "a"],
          parentId: null,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/files/batch", "POST", {
          operation: "delete",
          ids: Array.from({ length: 201 }, (_, i) => String(i)),
        })
      ).status,
    ).toBe(400);
  });

  it("streams owner-authenticated content without redirecting credentials or exposing storage keys", async () => {
    file("private", { name: "素材.mp4" });
    file("foreign", { userId: "other" });
    const get = vi.fn(async () => ({ body: new Blob(["file content"]).stream(), size: 12 }));
    setR2BucketProvider(() => ({ put: vi.fn(), get }));
    expect((await request("/files/foreign/content")).status).toBe(404);
    expect(get).not.toHaveBeenCalled();
    const response = await request("/files/private/content");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("file content");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Disposition")).toContain("attachment;");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(get).toHaveBeenCalledWith("private-key/private");
  });

  it("rejects malformed JSON and over-limit streamed bodies before mutation", async () => {
    const token = await sign(
      {
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier": USER,
        exp: Math.floor(Date.now() / 1000) + 300,
      },
      SECRET,
      "HS256",
    );
    for (const [body, expected] of [
      ["{", 400],
      [JSON.stringify({ name: "x".repeat(40_000), parentId: null }), 413],
    ] as const) {
      const response = await api.request("/api/v3/storage/folders", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body,
      });
      expect(response.status).toBe(expected);
      expect(await response.json()).toHaveProperty("error_code");
    }
    expect(memory.state.storageFolders.size).toBe(0);
  });

  it("rolls back a partial update if the write set changes and keeps files in use", async () => {
    file("a");
    file("b");
    file("dedicated", { visibility: "DEDICATED" });
    const realUpdate = memory.prisma.file.updateMany;
    vi.spyOn(memory.prisma.file, "updateMany").mockImplementationOnce(async (input) => {
      await realUpdate(input);
      return { count: 1 };
    });
    const failed = await request("/files/batch", "POST", {
      operation: "visibility",
      ids: ["a", "b"],
      visibility: "PUBLIC",
    });
    expect(failed.status).toBe(500);
    expect(memory.state.files.get("a")?.visibility).toBe("PRIVATE");
    expect(memory.state.files.get("b")?.visibility).toBe("PRIVATE");
    expect(
      (await request("/files/batch", "POST", { operation: "delete", ids: ["a", "dedicated"] }))
        .status,
    ).toBe(409);
    expect(memory.state.files.has("a")).toBe(true);
    folder("protected");
    memory.state.files.get("dedicated")!.folderId = "protected";
    expect((await request("/folders/protected?recursive=true", "DELETE")).status).toBe(409);
    expect(memory.state.storageFolders.has("protected")).toBe(true);
  });

  it("deletes only owned empty folders without recursive intent", async () => {
    for (const query of ["", "?recursive=false"]) {
      folder("empty");
      const deleted = await request(`/folders/empty${query}`, "DELETE");
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ deletedFiles: 0, deletedFolders: 1 });
      expect(memory.state.storageFolders.has("empty")).toBe(false);
    }
    folder("foreign", "other");
    for (const id of ["foreign", "missing"]) {
      const response = await request(`/folders/${id}`, "DELETE");
      expect(response.status).toBe(404);
      expect(await response.json()).toHaveProperty("error_code", "storageFolderNotFound");
    }
    expect(memory.state.storageFolders.has("foreign")).toBe(true);
    expect(memory.state.aiStorageCleanups.size).toBe(0);
  });

  it.each(["created file", "moved file", "created folder", "moved folder"])(
    "rejects nonrecursive deletion when a %s arrives before its transaction",
    async (arrival) => {
      folder("parent");
      if (arrival === "moved file") file("incoming-file");
      if (arrival === "moved folder") folder("incoming-folder");
      const transaction = memory.prisma.$transaction;
      vi.spyOn(memory.prisma, "$transaction").mockImplementationOnce(async (run) => {
        // The old API had already checked an empty summary at this point.
        // A concurrent request commits its creation or move before deletion starts.
        if (arrival.endsWith("folder")) {
          folder("incoming-folder", USER, "parent");
          file("incoming-file", { folderId: "incoming-folder" });
        } else {
          file("incoming-file", { folderId: "parent" });
        }
        return transaction(run);
      });

      const response = await request("/folders/parent?recursive=false", "DELETE");

      expect(response.status).toBe(409);
      expect(await response.json()).toHaveProperty("error_code", "storageFolderNotEmpty");
      expect(memory.state.storageFolders.has("parent")).toBe(true);
      expect(memory.state.files.get("incoming-file")?.folderId).toBe(
        arrival.endsWith("folder") ? "incoming-folder" : "parent",
      );
      if (arrival.endsWith("folder")) {
        expect(memory.state.storageFolders.get("incoming-folder")?.parentId).toBe("parent");
      }
      expect(memory.state.aiStorageCleanups.size).toBe(0);
    },
  );

  it.each(["file", "folder"])(
    "rechecks nonrecursive emptiness after a concurrent %s causes a serialization retry",
    async (kind) => {
      folder("parent");
      const transaction = memory.prisma.$transaction;
      const conflict = Object.assign(new Error("write conflict"), { code: "P2034" });
      const transactions = vi.spyOn(memory.prisma, "$transaction");
      transactions.mockImplementationOnce(async (run) => {
        try {
          return await transaction(async (tx) => {
            await run(tx);
            // Roll back the attempted deletion before exposing the concurrent commit.
            throw conflict;
          });
        } catch (error) {
          if (kind === "file") file("incoming", { folderId: "parent" });
          else folder("incoming", USER, "parent");
          throw error;
        }
      });

      const response = await request("/folders/parent", "DELETE");

      expect(response.status).toBe(409);
      expect(await response.json()).toHaveProperty("error_code", "storageFolderNotEmpty");
      expect(transactions).toHaveBeenCalledTimes(2);
      for (const call of transactions.mock.calls) {
        expect(call).toEqual([expect.any(Function), { isolationLevel: "Serializable" }]);
      }
      expect(memory.state.storageFolders.has("parent")).toBe(true);
      expect(
        kind === "file"
          ? memory.state.files.get("incoming")?.folderId
          : memory.state.storageFolders.get("incoming")?.parentId,
      ).toBe("parent");
      expect(memory.state.aiStorageCleanups.size).toBe(0);
    },
  );

  it("keeps files omitted from the listing attached during nonrecursive deletion", async () => {
    folder("parent");
    file("ai-result", { folderId: "parent" });
    memory.state.aiJobs.set("job", { id: "job", resultFileId: "ai-result" } as never);

    const response = await request("/folders/parent", "DELETE");

    expect(response.status).toBe(409);
    expect(memory.state.storageFolders.has("parent")).toBe(true);
    expect(memory.state.files.get("ai-result")?.folderId).toBe("parent");
    expect(memory.state.aiStorageCleanups.size).toBe(0);
  });

  it("requires recursive intent for nonempty folders and uses the durable deletion path", async () => {
    folder("parent");
    folder("child", USER, "parent");
    file("nested", { folderId: "child" });
    const summary = await (await request("/folders/parent")).json();
    expect(summary).toMatchObject({ fileCount: 1, folderCount: 1 });
    expect((await request("/folders/parent", "DELETE")).status).toBe(409);
    expect(memory.state.files.has("nested")).toBe(true);
    const deleted = await request("/folders/parent?recursive=true", "DELETE");
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ deletedFiles: 1, deletedFolders: 2 });
    expect(memory.state.files.has("nested")).toBe(false);
    expect(memory.state.storageFolders.has("child")).toBe(false);
    expect(memory.state.aiStorageCleanups.has("private-key/nested")).toBe(true);
  });
});
