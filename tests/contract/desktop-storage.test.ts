import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sign } from "hono/jwt";
import { setDbProvider } from "@beutl/db";
import { api } from "@beutl/api";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const USER = "desktop-storage-user";
const SECRET = "desktop-storage-contract-test-secret";

describe("GET /api/v3/storage", () => {
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
      id, userId: USER, objectKey: `private-key/${id}`, name: id, size: 1024,
      mimeType: "image/png", visibility: "PRIVATE", sha256: null, folderId: null,
      createdAt: new Date("2026-09-01T00:00:00Z"), updatedAt: new Date(),
      ...overrides,
    } as never);
  }

  function folder(id: string, userId = USER, parentId: string | null = null) {
    memory.state.storageFolders.set(id, {
      id, userId, parentId, name: id, createdAt: new Date(), updatedAt: new Date(),
    });
  }

  async function request(query = "", userId = USER) {
    const token = await sign({
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier": userId,
      exp: Math.floor(Date.now() / 1000) + 300,
    }, SECRET, "HS256");
    return api.request(`/api/v3/storage${query}`, { headers: { Authorization: `Bearer ${token}` } });
  }

  it("requires a valid bearer token before touching the database and prevents caching", async () => {
    const db = vi.fn(async () => memory.prisma as never);
    setDbProvider(db);
    for (const authorization of [undefined, "Bearer invalid-token"]) {
      const response = await api.request("/api/v3/storage", {
        headers: authorization ? { Authorization: authorization } : {},
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Vary")).toBe("Authorization");
    }
    expect(db).not.toHaveBeenCalled();
  });

  it("returns only the owner's storage, serializes bytes and dates, and omits object keys", async () => {
    folder("mine");
    folder("foreign", "other");
    file("root", { size: 5 * 1024 ** 3 });
    file("nested", { folderId: "mine" });
    file("foreign-file", { userId: "other" });
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Vary")).toBe("Authorization");
    const body = await response.json();
    expect(body).toMatchObject({
      folderId: null, total: 1, page: 1, pageCount: 1,
      files: [{ id: "root", size: 5 * 1024 ** 3, createdAt: "2026-09-01T00:00:00.000Z" }],
      folders: [{ id: "mine", parentId: null }],
      usage: { usedBytes: 5 * 1024 ** 3 + 1024, fileCount: 2 },
    });
    expect(body.files).toHaveLength(1);
    expect(body.folders).toHaveLength(1);
    expect(body.files[0]).not.toHaveProperty("objectKey");
    expect(body.files[0]).not.toHaveProperty("userId");
    expect(body.folders[0]).not.toHaveProperty("userId");
  });

  it("browses nested folders and normalizes deleted or foreign folders to the owner's root", async () => {
    folder("mine");
    folder("child", USER, "mine");
    folder("foreign", "other");
    file("root");
    file("nested", { folderId: "mine" });
    const nested = await (await request("?folder=mine")).json();
    expect(nested.folderId).toBe("mine");
    expect(nested.files.map((x: { id: string }) => x.id)).toEqual(["nested"]);
    for (const target of ["foreign", "deleted"]) {
      const body = await (await request(`?folder=${target}`)).json();
      expect(body.folderId).toBeNull();
      expect(body.files.map((x: { id: string }) => x.id)).toEqual(["root"]);
    }
  });

  it("searches across folders and pages a bounded result with stable ordering", async () => {
    folder("mine");
    for (let i = 0; i < 30; i++) {
      file(`clip-${String(i).padStart(2, "0")}`, { folderId: i % 2 ? "mine" : null });
    }
    file("foreign-clip", { userId: "other" });
    const first = await (await request("?q=clip&sort=name")).json();
    const second = await (await request("?q=clip&sort=name&page=2")).json();
    expect(first).toMatchObject({ total: 30, page: 1, pageCount: 2 });
    expect(first.files).toHaveLength(24);
    expect(second.files).toHaveLength(6);
    expect(new Set([...first.files, ...second.files].map((x: { id: string }) => x.id)).size).toBe(30);
    const clamped = await (await request("?q=clip&page=99999")).json();
    expect(clamped.page).toBe(2);
  });
});
