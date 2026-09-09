import { describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_STORAGE_DRAIN_BATCH,
  drainUserStorageFiles,
  setDbProvider,
  StorageCleanupBusyError,
} from "@beutl/db";

// Before the User cascade, the account's plain files are retired a page at a
// time, each page in its own transaction. The cascade then only has what the
// file limit does not govern.
describe("draining an account's storage before deletion", () => {
  const now = new Date("2026-09-09T00:00:00.000Z");

  type FakeFile = {
    id: string;
    objectKey: string;
    aiResult?: boolean;
    referenced?: boolean;
    dedicated?: boolean;
  };

  function fakeDatabase({
    files,
    intentLive = true,
    outbox = [],
  }: {
    files: FakeFile[];
    intentLive?: boolean;
    outbox?: { objectKey: string; leaseToken: string | null }[];
  }) {
    let remaining = [...files];
    const transactions: number[] = [];
    const deleteSizes: number[] = [];
    const created: { objectKey: string; state: string; notBefore: Date }[] = [];
    const tx = {
      accountDeletionIntent: {
        findFirst: vi.fn(async ({ where }: { where: { userId: string; expiresAt: { gt: Date } } }) => {
          expect(where.userId).toBe("user-1");
          return intentLive ? { userId: "user-1" } : null;
        }),
      },
      file: {
        findMany: vi.fn(async ({ where, take, select, orderBy }: { where: Record<string, unknown>; take: number; select: Record<string, unknown>; orderBy: unknown }) => {
          expect(where).toMatchObject({ userId: "user-1", aiJobResult: null });
          expect(where.NOT).toBeDefined();
          expect(select).toEqual({ id: true, objectKey: true });
          expect(orderBy).toEqual({ id: "asc" });
          return remaining
            .filter((file) => !file.aiResult && !file.referenced && !file.dedicated)
            .sort((left, right) => left.id.localeCompare(right.id))
            .slice(0, take)
            .map((file) => ({ id: file.id, objectKey: file.objectKey }));
        }),
        deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] }; userId: string } }) => {
          deleteSizes.push(where.id.in.length);
          const ids = new Set(where.id.in);
          const before = remaining.length;
          remaining = remaining.filter((file) => !ids.has(file.id));
          return { count: before - remaining.length };
        }),
      },
      aiStorageCleanup: {
        findMany: vi.fn(async ({ where }: { where: { objectKey: { in: string[] } } }) =>
          outbox
            .filter((row) => where.objectKey.in.includes(row.objectKey))
            .map((row) => ({ ...row, state: "cleanup", notBefore: now })),
        ),
        createMany: vi.fn(async ({ data, skipDuplicates }: { data: typeof created; skipDuplicates: boolean }) => {
          expect(skipDuplicates).toBe(true);
          created.push(...data);
          return { count: data.length };
        }),
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
    return { tx, transactions, deleteSizes, created, remaining: () => remaining };
  }

  const plainFiles = (count: number): FakeFile[] =>
    Array.from({ length: count }, (_, index) => ({
      id: `file-${String(index).padStart(6, "0")}`,
      objectKey: `storage/user-1/${index}`,
    }));

  it("retires the plain files in bounded pages, each in its own transaction, and leaves the rest to the cascade", async () => {
    const plain = ACCOUNT_STORAGE_DRAIN_BATCH * 2 + 250;
    const fake = fakeDatabase({
      files: [
        ...plainFiles(plain),
        { id: "ai-1", objectKey: "ai/image/job-1/output", aiResult: true },
        { id: "release-1", objectKey: "packages/user-1/archive", referenced: true },
        { id: "dedicated-1", objectKey: "packages/user-1/icon", dedicated: true },
      ],
      // A row from an earlier abort is moved up to cleanup, not duplicated.
      outbox: [{ objectKey: "storage/user-1/0", leaseToken: null }],
    });

    await expect(drainUserStorageFiles({ userId: "user-1", now })).resolves.toEqual({
      kind: "drained",
      fileCount: plain,
    });

    expect(fake.deleteSizes).toEqual([ACCOUNT_STORAGE_DRAIN_BATCH, ACCOUNT_STORAGE_DRAIN_BATCH, 250]);
    // Three pages and the empty check: never one transaction over the account.
    expect(fake.transactions).toHaveLength(4);
    expect(fake.remaining().map((file) => file.id)).toEqual(["ai-1", "release-1", "dedicated-1"]);
    expect(fake.created).toHaveLength(plain);
    expect(fake.created.every((row) => row.state === "cleanup" && row.notBefore.getTime() === now.getTime())).toBe(true);
    expect(fake.tx.aiStorageCleanup.updateMany).toHaveBeenCalledTimes(1);
    expect(fake.tx.aiStorageCleanup.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ objectKey: { in: ["storage/user-1/0"] } }) }),
    );
  });

  it("drains nothing without a live deletion intent", async () => {
    const fake = fakeDatabase({ files: plainFiles(3), intentLive: false });

    await expect(drainUserStorageFiles({ userId: "user-1", now })).resolves.toEqual({
      kind: "notAuthorized",
    });

    expect(fake.tx.file.deleteMany).not.toHaveBeenCalled();
    expect(fake.tx.aiStorageCleanup.createMany).not.toHaveBeenCalled();
    expect(fake.remaining()).toHaveLength(3);
  });

  it("stops before deleting a page whose object a cleaner has leased", async () => {
    const fake = fakeDatabase({
      files: plainFiles(3),
      outbox: [{ objectKey: "storage/user-1/1", leaseToken: "claim-token" }],
    });

    await expect(drainUserStorageFiles({ userId: "user-1", now })).rejects.toBeInstanceOf(
      StorageCleanupBusyError,
    );

    expect(fake.tx.file.deleteMany).not.toHaveBeenCalled();
    expect(fake.tx.aiStorageCleanup.createMany).not.toHaveBeenCalled();
    expect(fake.remaining()).toHaveLength(3);
  });
});
