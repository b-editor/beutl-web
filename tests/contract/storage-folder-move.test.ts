import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { moveStorageFiles, moveStorageFolder } from "@beutl/db";

type FakeFolder = { userId: string; parentId: string | null };

// A transaction with just the reads and writes the folder module touches. The
// module is handed this directly, so no real transaction is started.
function fakeTransaction(options: {
  ownedFileIds: string[];
  folders: Record<string, FakeFolder>;
}) {
  const fileUpdateMany = vi.fn(async () => ({ count: options.ownedFileIds.length }));
  const folderUpdateMany = vi.fn(
    async ({ where }: { where: { id: string; userId: string } }) => ({
      count: options.folders[where.id]?.userId === where.userId ? 1 : 0,
    }),
  );
  const tx = {
    file: {
      count: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.filter((id) => options.ownedFileIds.includes(id)).length),
      updateMany: fileUpdateMany,
    },
    storageFolder: {
      count: vi.fn(async ({ where }: { where: { id: string; userId: string } }) =>
        options.folders[where.id]?.userId === where.userId ? 1 : 0),
      findFirst: vi.fn(async ({ where }: { where: { id: string; userId: string } }) => {
        const folder = options.folders[where.id];
        return folder && folder.userId === where.userId
          ? { parentId: folder.parentId }
          : null;
      }),
      updateMany: folderUpdateMany,
    },
  };
  return { tx: tx as never, fileUpdateMany, folderUpdateMany };
}

describe("moveStorageFiles", () => {
  it("moves nothing when any requested file is not the owner's", async () => {
    const { tx, fileUpdateMany } = fakeTransaction({
      ownedFileIds: ["file-1"],
      folders: { "folder-1": { userId: "user-1", parentId: null } },
    });
    await expect(
      moveStorageFiles({
        fileIds: ["file-1", "someone-elses"],
        userId: "user-1",
        folderId: "folder-1",
        prisma: tx,
      }),
    ).resolves.toEqual({ kind: "notFound" });
    expect(fileUpdateMany).not.toHaveBeenCalled();
  });

  it("moves every file once all of them are the owner's", async () => {
    const { tx, fileUpdateMany } = fakeTransaction({
      ownedFileIds: ["file-1", "file-2"],
      folders: { "folder-1": { userId: "user-1", parentId: null } },
    });
    await expect(
      moveStorageFiles({
        fileIds: ["file-1", "file-2", "file-2"],
        userId: "user-1",
        folderId: "folder-1",
        prisma: tx,
      }),
    ).resolves.toEqual({ kind: "moved" });
    expect(fileUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["file-1", "file-2"] }, userId: "user-1", aiJobResult: null },
      data: { folderId: "folder-1" },
    });
  });

  it("refuses a destination folder that is not the owner's", async () => {
    const { tx, fileUpdateMany } = fakeTransaction({
      ownedFileIds: ["file-1"],
      folders: { "folder-1": { userId: "user-2", parentId: null } },
    });
    await expect(
      moveStorageFiles({
        fileIds: ["file-1"],
        userId: "user-1",
        folderId: "folder-1",
        prisma: tx,
      }),
    ).resolves.toEqual({ kind: "targetNotFound" });
    expect(fileUpdateMany).not.toHaveBeenCalled();
  });
});

describe("moveStorageFolder", () => {
  const tree: Record<string, FakeFolder> = {
    a: { userId: "user-1", parentId: null },
    b: { userId: "user-1", parentId: "a" },
    c: { userId: "user-1", parentId: "b" },
  };

  it("refuses to move a folder under itself or one of its descendants", async () => {
    const { tx, folderUpdateMany } = fakeTransaction({ ownedFileIds: [], folders: tree });
    await expect(
      moveStorageFolder({ folderId: "a", userId: "user-1", parentId: "c", prisma: tx }),
    ).resolves.toEqual({ kind: "intoItself" });
    await expect(
      moveStorageFolder({ folderId: "a", userId: "user-1", parentId: "a", prisma: tx }),
    ).resolves.toEqual({ kind: "intoItself" });
    expect(folderUpdateMany).not.toHaveBeenCalled();
  });

  it("moves a folder to the root and under a sibling branch", async () => {
    const { tx, folderUpdateMany } = fakeTransaction({ ownedFileIds: [], folders: tree });
    await expect(
      moveStorageFolder({ folderId: "c", userId: "user-1", parentId: null, prisma: tx }),
    ).resolves.toEqual({ kind: "moved" });
    await expect(
      moveStorageFolder({ folderId: "b", userId: "user-1", parentId: "a", prisma: tx }),
    ).resolves.toEqual({ kind: "moved" });
    expect(folderUpdateMany).toHaveBeenCalledTimes(2);
  });

  it("reports a destination that is not the owner's", async () => {
    const { tx } = fakeTransaction({
      ownedFileIds: [],
      folders: { ...tree, x: { userId: "user-2", parentId: null } },
    });
    await expect(
      moveStorageFolder({ folderId: "a", userId: "user-1", parentId: "x", prisma: tx }),
    ).resolves.toEqual({ kind: "targetNotFound" });
  });
});
