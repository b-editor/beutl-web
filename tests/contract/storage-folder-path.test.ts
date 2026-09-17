import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  setDbProvider,
  storageFolderPath,
  storageFolderSummary,
  updateOwnedStorageFolder,
} from "@beutl/db";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

describe("storage folder ancestor lookup", () => {
  let memory: ReturnType<typeof createInMemoryPrisma>;
  beforeEach(() => {
    memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
  });

  function folder(id: string, parentId: string | null = null, userId = "owner") {
    memory.state.storageFolders.set(id, {
      id,
      parentId,
      userId,
      name: `Name ${id}`,
      createdAt: new Date("2026-09-01T00:00:00Z"),
      updatedAt: new Date("2026-09-02T00:00:00Z"),
    });
  }

  it("fetches a deep path in one query and reconstructs root-first order", async () => {
    for (let i = 0; i < 128; i++) folder(`folder-${i}`, i ? `folder-${i - 1}` : null);
    const query = vi.spyOn(memory.prisma, "$queryRaw");
    const individual = vi.spyOn(memory.prisma.storageFolder, "findFirst");

    const path = await storageFolderPath("owner", "folder-127");

    expect(path?.map((entry) => entry.id)).toEqual(
      Array.from({ length: 128 }, (_, i) => `folder-${i}`),
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(individual).not.toHaveBeenCalled();
  });

  it("does not query folders for the storage root", async () => {
    const query = vi.spyOn(memory.prisma, "$queryRaw");
    await expect(storageFolderPath("owner", null)).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects missing or foreign folders anywhere in the path", async () => {
    folder("foreign", null, "other");
    folder("owned-child", "foreign");
    folder("orphan", "missing");
    for (const id of ["missing", "foreign", "owned-child", "orphan"]) {
      await expect(storageFolderPath("owner", id)).resolves.toBeNull();
    }
  });

  it.each([true, false])("terminates and rejects cyclic ancestry (self: %s)", async (self) => {
    folder("a", self ? "a" : "b");
    folder("b", "a");
    await expect(storageFolderPath("owner", "a")).rejects.toThrow(
      "Cyclic storage folder hierarchy",
    );
  });

  it("checks move destinations inside the mutation transaction", async () => {
    folder("parent");
    folder("child", "parent");
    const query = vi.spyOn(memory.prisma, "$queryRaw");
    await expect(
      updateOwnedStorageFolder("owner", "parent", { parentId: "child" }),
    ).resolves.toEqual({ kind: "intoItself" });
    expect(memory.state.storageFolders.get("parent")?.parentId).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("summarizes a deep tree with a fixed number of queries and excludes foreign branches and AI files", async () => {
    for (let i = 0; i < 256; i++) folder(`folder-${i}`, i ? `folder-${i - 1}` : null);
    folder("foreign", "folder-0", "other");
    folder("hidden", "foreign");
    for (const [id, folderId, userId] of [
      ["root-file", "folder-0", "owner"],
      ["leaf-file", "folder-255", "owner"],
      ["foreign-file", "folder-0", "other"],
      ["hidden-file", "hidden", "owner"],
      ["ai-result", "folder-255", "owner"],
    ])
      memory.state.files.set(id, { id, folderId, userId } as never);
    memory.state.aiJobs.set("job", { id: "job", resultFileId: "ai-result" } as never);
    const query = vi.spyOn(memory.prisma, "$queryRaw");
    const children = vi.spyOn(memory.prisma.storageFolder, "findMany");
    const files = vi.spyOn(memory.prisma.file, "count");

    expect(await storageFolderSummary("owner", "folder-0")).toMatchObject({
      folder: { id: "folder-0" },
      ancestors: [],
      folderCount: 255,
      fileCount: 2,
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(children).not.toHaveBeenCalled();
    expect(files).not.toHaveBeenCalled();
  });

  it("returns null when the folder disappears between the path and counts queries", async () => {
    folder("root");
    const original = memory.prisma.$queryRaw;
    vi.spyOn(memory.prisma, "$queryRaw").mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      memory.state.storageFolders.delete("root");
      return result;
    });
    await expect(storageFolderSummary("owner", "root")).resolves.toBeNull();
  });
});
