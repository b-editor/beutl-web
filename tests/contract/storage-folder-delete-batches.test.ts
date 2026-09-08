import { describe, expect, it, vi } from "vitest";
import {
  deleteStorageFolderTree,
  setDbProvider,
  STORAGE_FOLDER_DELETE_BATCH,
} from "@beutl/db";

// A folder may hold as many files as the account is allowed. Deleting it must
// not put every file into one statement or one transaction, and the tree it
// deletes from is the live one, batch by batch.
describe("deleting a folder with many files", () => {
  type FakeFile = { id: string; objectKey: string; folderId: string };

  function fakeDatabase({
    files,
    childrenOf = {},
    inUse = 0,
  }: {
    files: FakeFile[];
    // parentId -> child folder ids; mutable so a test can move a folder.
    childrenOf?: Record<string, string[]>;
    inUse?: number;
  }) {
    let remaining = [...files];
    const transactions: number[] = [];
    const deleteSizes: number[] = [];
    const tx = {
      storageFolder: {
        count: vi.fn(async () => 1),
        findMany: vi.fn(async ({ where }: { where: { parentId: { in: string[] } } }) =>
          where.parentId.in.flatMap((parent) => (childrenOf[parent] ?? []).map((id) => ({ id }))),
        ),
        deleteMany: vi.fn(async () => ({ count: 1 })),
      },
      file: {
        count: vi.fn(async () => inUse),
        findMany: vi.fn(async ({ where, take, select }: { where: { id?: { in: string[] }; folderId?: { in: string[] } }; take?: number; select: Record<string, unknown> }) => {
          if (where.id) {
            return remaining
              .filter((file) => where.id!.in.includes(file.id))
              .map((file) => ({ ...file, visibility: "PRIVATE", Package: [], PackageScreenshot: [], Profile: [], Release: [], aiJobResult: null }));
          }
          expect(select).toEqual({ id: true });
          expect(take).toBe(STORAGE_FOLDER_DELETE_BATCH);
          return remaining
            .filter((file) => where.folderId!.in.includes(file.folderId))
            .sort((left, right) => left.id.localeCompare(right.id))
            .slice(0, take)
            .map((file) => ({ id: file.id }));
        }),
        deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
          deleteSizes.push(where.id.in.length);
          const ids = new Set(where.id.in);
          const before = remaining.length;
          remaining = remaining.filter((file) => !ids.has(file.id));
          return { count: before - remaining.length };
        }),
      },
      aiStorageCleanup: {
        createMany: vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length })),
        updateMany: vi.fn(async ({ where }: { where: { objectKey: { in: string[] } } }) => ({ count: where.objectKey.in.length })),
      },
    };
    const db = {
      $transaction: async <T,>(run: (tx: unknown) => Promise<T>) => {
        transactions.push(remaining.length);
        return await run(tx);
      },
    };
    setDbProvider(async () => db as never);
    return { tx, transactions, deleteSizes, remaining: () => remaining };
  }

  const rootFiles = (count: number, prefix = "a", folderId = "folder-1"): FakeFile[] =>
    Array.from({ length: count }, (_, index) => ({
      id: `${prefix}-${String(index).padStart(6, "0")}`,
      objectKey: `${prefix}-object-${index}`,
      folderId,
    }));

  it("deletes the files in bounded batches, each in its own transaction, then the folder", async () => {
    const files = STORAGE_FOLDER_DELETE_BATCH * 2 + 17;
    const fake = fakeDatabase({ files: rootFiles(files) });

    await expect(
      deleteStorageFolderTree({ folderId: "folder-1", userId: "user-1" }),
    ).resolves.toEqual({ kind: "deleted", fileCount: files, folderCount: 1 });

    expect(fake.deleteSizes).toEqual([STORAGE_FOLDER_DELETE_BATCH, STORAGE_FOLDER_DELETE_BATCH, 17]);
    // Preflight, three batches, the empty check, the folder: never one
    // transaction over the whole tree.
    expect(fake.transactions).toHaveLength(6);
    expect(fake.remaining()).toHaveLength(0);
    expect(fake.tx.storageFolder.deleteMany).toHaveBeenCalledWith({
      where: { id: "folder-1", userId: "user-1" },
    });
    // The outbox is written per batch, not per file.
    expect(fake.tx.aiStorageCleanup.createMany).toHaveBeenCalledTimes(3);
  });

  it("leaves a child folder alone once it has been moved out of the tree mid-deletion", async () => {
    // The root holds a batch and a bit; the child holds more. The child is
    // moved to the root of the account after the first batch commits.
    const childrenOf: Record<string, string[]> = { "folder-1": ["folder-2"] };
    const fake = fakeDatabase({
      files: [
        ...rootFiles(STORAGE_FOLDER_DELETE_BATCH + 50, "a"),
        ...rootFiles(STORAGE_FOLDER_DELETE_BATCH + 50, "b", "folder-2"),
      ],
      childrenOf,
    });
    fake.tx.file.deleteMany.mockImplementationOnce(async (args: { where: { id: { in: string[] } } }) => {
      const result = await (fake.tx.file.deleteMany.getMockImplementation() as (a: typeof args) => Promise<{ count: number }>)?.(args);
      childrenOf["folder-1"] = [];
      return result ?? { count: 0 };
    });

    await expect(
      deleteStorageFolderTree({ folderId: "folder-1", userId: "user-1" }),
    ).resolves.toEqual({ kind: "deleted", fileCount: STORAGE_FOLDER_DELETE_BATCH + 50, folderCount: 1 });

    // Every one of the moved folder's files survives.
    expect(fake.remaining().every((file) => file.folderId === "folder-2")).toBe(true);
    expect(fake.remaining()).toHaveLength(STORAGE_FOLDER_DELETE_BATCH + 50);
  });

  it("refuses the whole tree when a file in it is still in use, before deleting anything", async () => {
    const fake = fakeDatabase({ files: rootFiles(50), inUse: 1 });
    await expect(
      deleteStorageFolderTree({ folderId: "folder-1", userId: "user-1" }),
    ).resolves.toEqual({ kind: "inUse" });
    expect(fake.tx.file.deleteMany).not.toHaveBeenCalled();
    expect(fake.tx.storageFolder.deleteMany).not.toHaveBeenCalled();
  });
});
