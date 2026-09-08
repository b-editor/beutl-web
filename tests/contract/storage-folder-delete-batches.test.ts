import { describe, expect, it, vi } from "vitest";
import {
  deleteStorageFolderTree,
  setDbProvider,
  STORAGE_FOLDER_DELETE_BATCH,
} from "@beutl/db";

// A folder may hold as many files as the account is allowed. Deleting it must
// not put every file into one statement or one transaction.
describe("deleting a folder with many files", () => {
  function fakeDatabase(fileCount: number, inUse = 0) {
    let remaining = Array.from({ length: fileCount }, (_, index) => ({
      id: `file-${String(index).padStart(6, "0")}`,
      objectKey: `object-${index}`,
    }));
    const transactions: number[] = [];
    const deleteSizes: number[] = [];
    const tx = {
      storageFolder: {
        count: vi.fn(async () => 1),
        findMany: vi.fn(async () => []),
        deleteMany: vi.fn(async () => ({ count: 1 })),
      },
      file: {
        count: vi.fn(async () => inUse),
        findMany: vi.fn(async ({ where, take, select }: { where: { id?: { in: string[] } }; take?: number; select: Record<string, unknown> }) => {
          if (where.id) {
            return remaining
              .filter((file) => where.id!.in.includes(file.id))
              .map((file) => ({ ...file, visibility: "PRIVATE", Package: [], PackageScreenshot: [], Profile: [], Release: [], aiJobResult: null }));
          }
          expect(select).toEqual({ id: true });
          expect(take).toBe(STORAGE_FOLDER_DELETE_BATCH);
          return remaining.slice(0, take).map((file) => ({ id: file.id }));
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
    return { tx, transactions, deleteSizes, remaining: () => remaining.length };
  }

  it("deletes the files in bounded batches, each in its own transaction, then the folder", async () => {
    const files = STORAGE_FOLDER_DELETE_BATCH * 2 + 17;
    const fake = fakeDatabase(files);

    await expect(
      deleteStorageFolderTree({ folderId: "folder-1", userId: "user-1" }),
    ).resolves.toEqual({ kind: "deleted", fileCount: files, folderCount: 1 });

    expect(fake.deleteSizes).toEqual([STORAGE_FOLDER_DELETE_BATCH, STORAGE_FOLDER_DELETE_BATCH, 17]);
    // Preflight, three batches, the empty check, the folder: never one
    // transaction over the whole tree.
    expect(fake.transactions).toHaveLength(6);
    expect(fake.remaining()).toBe(0);
    expect(fake.tx.storageFolder.deleteMany).toHaveBeenCalledWith({
      where: { id: "folder-1", userId: "user-1" },
    });
    // The outbox is written per batch, not per file.
    expect(fake.tx.aiStorageCleanup.createMany).toHaveBeenCalledTimes(3);
  });

  it("refuses the whole tree when a file in it is still in use, before deleting anything", async () => {
    const fake = fakeDatabase(50, 1);
    await expect(
      deleteStorageFolderTree({ folderId: "folder-1", userId: "user-1" }),
    ).resolves.toEqual({ kind: "inUse" });
    expect(fake.tx.file.deleteMany).not.toHaveBeenCalled();
    expect(fake.tx.storageFolder.deleteMany).not.toHaveBeenCalled();
  });
});
