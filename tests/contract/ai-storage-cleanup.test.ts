import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AI_STORAGE_CLEANUP_LEASE_MILLISECONDS,
  claimAiStorageCleanupForDeletion,
  finalizeReconciledAiStorageCleanup,
  registerAiStorageCleanup,
  StorageCleanupBusyError,
  setDbProvider,
} from "@beutl/db";
import {
  isTerminalMultipartAbortError,
  reconcileAiStorageCleanups,
  setR2BucketProvider,
} from "@beutl/api";

describe("AI storage multipart cleanup", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("recognizes only the documented NoSuchUpload terminal shape", () => {
    expect(
      isTerminalMultipartAbortError({ code: "NoSuchUpload", status: 404 }),
    ).toBe(true);
    expect(
      isTerminalMultipartAbortError(new Error("R2 multipart error (10024)")),
    ).toBe(true);
    expect(
      isTerminalMultipartAbortError({ code: "NoSuchBucket", status: 404 }),
    ).toBe(false);
    expect(
      isTerminalMultipartAbortError(new Error("cannot abort upload: service unavailable")),
    ).toBe(false);
  });

  it("does not overwrite an active lease during output registration", async () => {
    const now = new Date();
    const db = {
      aiStorageCleanup: {
        findFirst: async () => ({
          objectKey: "ai/image/job-3/output",
          leaseToken: "active-token",
          notBefore: new Date(now.getTime() + 60_000),
        }),
      },
    } as never;
    setDbProvider(async () => db);
    await expect(
      registerAiStorageCleanup({
        objectKey: "ai/image/job-3/output",
        aiJobId: "job-3",
        notBefore: now,
      }),
    ).rejects.toBeInstanceOf(StorageCleanupBusyError);
  });

  it("does not let a writer take over an expired cleaner lease", async () => {
    const now = new Date("2026-08-25T02:00:00.000Z");
    const row = {
      objectKey: "ai/image/job-expired/output",
      aiJobId: null,
      leaseToken: "expired-cleaner",
      notBefore: new Date(now.getTime() - 1),
      state: "cleanup",
    };
    const db = {
      $transaction: async <T>(callback: (tx: typeof db) => Promise<T>) =>
        await callback(db),
      aiStorageCleanup: {
        findFirst: async () => row,
        updateMany: async ({
          where,
          data,
        }: {
          where: {
            objectKey: string;
            state?: string;
            notBefore?: Date;
            leaseToken: string | null;
          };
          data: { state?: string; notBefore?: Date; leaseToken?: string | null; aiJobId?: string };
        }) => {
          if (!where.state) {
            if (where.objectKey !== row.objectKey || row.leaseToken !== where.leaseToken) {
              return { count: 0 };
            }
            Object.assign(row, data);
            return { count: 1 };
          }
          if (
            where.objectKey !== row.objectKey ||
            where.state !== row.state ||
            where.notBefore!.getTime() !== row.notBefore.getTime() ||
            where.leaseToken !== row.leaseToken
          ) return { count: 0 };
          row.state = data.state;
          row.notBefore = data.notBefore;
          row.leaseToken = data.leaseToken;
          return { count: 1 };
        },
        create: async ({ data }: { data: typeof row }) => {
          Object.assign(row, data);
          return row;
        },
      },
    } as never;
    setDbProvider(async () => db);

    await expect(
      registerAiStorageCleanup({
        objectKey: row.objectKey,
        aiJobId: "job-expired",
        notBefore: now,
      }),
    ).rejects.toBeInstanceOf(StorageCleanupBusyError);

    const claimed = await claimAiStorageCleanupForDeletion({
      objectKey: row.objectKey,
      state: row.state,
      notBefore: row.notBefore,
      now,
      leaseToken: row.leaseToken,
    });
    expect(claimed.claimed).toBe(true);
    expect(row.leaseToken).not.toBe("expired-cleaner");

    row.leaseToken = null as never;
    await expect(
      registerAiStorageCleanup({
        objectKey: row.objectKey,
        aiJobId: "job-expired",
        notBefore: now,
      }),
    ).resolves.toBe(row);
  });

  it("does not finalize a row whose claim token changed", async () => {
    const db = {
      $transaction: async <T>(callback: (tx: typeof db) => Promise<T>) =>
        await callback(db),
      aiStorageCleanup: {
        findFirst: async ({ where }: { where: { leaseToken?: string } }) =>
          where.leaseToken === "active-token" ? { aiJobId: null } : null,
        deleteMany: async () => ({ count: 1 }),
      },
    } as never;
    setDbProvider(async () => db);
    await expect(
      finalizeReconciledAiStorageCleanup({
        objectKey: "ai/image/job-4/output",
        aiJobId: null,
        leaseToken: "stale-token",
      }),
    ).resolves.toBe(false);
  });

  it("keeps the cleanup row and uploadId after a transient abort failure", async () => {
    const now = new Date("2026-08-25T00:00:00.000Z");
    const row = {
      objectKey: "ai/image/job-1/partial",
      aiJobId: null,
      uploadId: "upload-1",
      leaseToken: null as string | null,
      state: "cleanup",
      notBefore: now,
    };
    let abortAttempts = 0;
    const deleted: string[] = [];
    const db = {
      $transaction: async <T>(callback: (tx: typeof db) => Promise<T>) =>
        await callback(db),
      aiStorageCleanup: {
        findMany: async ({ where }: { where: { notBefore: { lte: Date } } }) =>
          row.objectKey && row.notBefore <= where.notBefore.lte ? [row] : [],
        updateMany: async ({
          where,
          data,
        }: {
          where: { objectKey: string; state: string; notBefore: Date; leaseToken: string | null };
          data: { state: string; notBefore: Date; leaseToken: string };
        }) => {
          if (
            row.objectKey !== where.objectKey ||
            row.state !== where.state ||
            row.notBefore.getTime() !== where.notBefore.getTime() ||
            row.leaseToken !== where.leaseToken
          ) return { count: 0 };
          row.state = data.state;
          row.notBefore = data.notBefore;
          row.leaseToken = data.leaseToken;
          return { count: 1 };
        },
        findFirst: async () => row,
        deleteMany: async () => {
          row.objectKey = "";
          return { count: 1 };
        },
      },
    } as never;
    setDbProvider(async () => db);
    setR2BucketProvider(() => ({
      delete: async (key: string) => {
        deleted.push(key);
      },
      resumeMultipartUpload: () => ({
        uploadPart: vi.fn(),
        complete: vi.fn(),
        abort: async () => {
          abortAttempts++;
          if (abortAttempts === 1) throw new Error("temporary R2 outage");
          if (abortAttempts === 2) {
            throw new Error("cannot abort upload: service unavailable");
          }
        },
      }),
    }));

    await expect(reconcileAiStorageCleanups(now)).resolves.toMatchObject({
      inspected: 1,
      deleted: 0,
      errors: 1,
    });
    expect(row.objectKey).toBe("ai/image/job-1/partial");
    expect(row.uploadId).toBe("upload-1");
    const leaseUntil = new Date(
      now.getTime() + AI_STORAGE_CLEANUP_LEASE_MILLISECONDS,
    );
    expect(row.notBefore).toEqual(leaseUntil);
    expect(deleted).toEqual([]);

    await expect(
      reconcileAiStorageCleanups(new Date(leaseUntil.getTime() - 1)),
    ).resolves.toMatchObject({
      inspected: 0,
      deleted: 0,
      errors: 0,
    });
    await expect(reconcileAiStorageCleanups(leaseUntil)).resolves.toMatchObject({
      inspected: 1,
      deleted: 0,
      errors: 1,
    });
    const secondLeaseUntil = new Date(
      leaseUntil.getTime() + AI_STORAGE_CLEANUP_LEASE_MILLISECONDS,
    );
    await expect(
      reconcileAiStorageCleanups(new Date(secondLeaseUntil.getTime() - 1)),
    ).resolves.toMatchObject({ inspected: 0, deleted: 0, errors: 0 });
    await expect(reconcileAiStorageCleanups(secondLeaseUntil)).resolves.toMatchObject({
      inspected: 1,
      deleted: 1,
      errors: 0,
    });
    expect(abortAttempts).toBe(3);
    expect(deleted).toEqual(["ai/image/job-1/partial"]);
    expect(row.objectKey).toBe("");
  });

  it("allows only one claimant for an identical cleanup snapshot", async () => {
    const now = new Date("2026-08-25T01:00:00.000Z");
    const row = {
      objectKey: "ai/image/job-2/partial",
      aiJobId: null,
      uploadId: "upload-2",
      leaseToken: null as string | null,
      state: "cleanup",
      notBefore: now,
    };
    const db = {
      $transaction: async <T>(callback: (tx: typeof db) => Promise<T>) =>
        await callback(db),
      aiStorageCleanup: {
        updateMany: async ({
          where,
          data,
        }: {
          where: { objectKey: string; state: string; notBefore: Date; leaseToken: string | null };
          data: { state: string; notBefore: Date; leaseToken: string };
        }) => {
          if (
            row.objectKey !== where.objectKey ||
            row.state !== where.state ||
            row.notBefore.getTime() !== where.notBefore.getTime() ||
            row.leaseToken !== where.leaseToken
          ) return { count: 0 };
          row.state = data.state;
          row.notBefore = data.notBefore;
          row.leaseToken = data.leaseToken;
          return { count: 1 };
        },
        findFirst: async () => row,
      },
    } as never;
    setDbProvider(async () => db);

    const [first, second] = await Promise.all([
      claimAiStorageCleanupForDeletion({
        objectKey: row.objectKey,
        state: row.state,
        notBefore: now,
        now,
      }),
      claimAiStorageCleanupForDeletion({
        objectKey: row.objectKey,
        state: row.state,
        notBefore: now,
        now,
      }),
    ]);
    expect([first.claimed, second.claimed].filter(Boolean)).toHaveLength(1);
    expect(row.notBefore).toEqual(
      new Date(now.getTime() + AI_STORAGE_CLEANUP_LEASE_MILLISECONDS),
    );
  });
});
