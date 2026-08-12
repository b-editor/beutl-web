import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { claimDueStorageCleanups } from "@beutl/db";
import {
  observeStorageCleanupBatch,
  runStorageCleanupBatch,
  scheduleStorageCleanupBatch,
  storageCleanupBatchFailureCode,
  storageCleanupBatchSize,
} from "@/lib/storage-cleanup-consumer";
import {
  createStorageCleanupFailureCounts,
  storageCleanupFailureCodes,
  type StorageCleanupDrainResult,
} from "@/lib/storage";

const bucket = {
  put: vi.fn(async () => undefined),
  delete: vi.fn(async () => undefined),
};

function drainResult(
  overrides: Partial<StorageCleanupDrainResult> = {},
): StorageCleanupDrainResult {
  return {
    claimed: 0,
    deleted: 0,
    cancelled: 0,
    deferred: 0,
    failureCounts: createStorageCleanupFailureCounts(),
    ...overrides,
  };
}

describe("scheduled storage cleanup consumer", () => {
  it("is wired as an autonomous five-minute OpenNext custom worker trigger", async () => {
    const wrangler = await readFile(
      new URL("../../apps/web/wrangler.jsonc", import.meta.url),
      "utf8",
    );
    const worker = await readFile(
      new URL("../../apps/web/worker.ts", import.meta.url),
      "utf8",
    );
    expect(wrangler).toContain('"main": "worker.ts"');
    expect(wrangler).toContain('"crons": ["*/5 * * * *"]');
    expect(worker).toContain("fetch: openNextHandler.fetch");
    expect(worker).toContain("scheduled(");
    expect(worker).toContain("controller: ScheduledControllerLike");
    expect(worker).toContain("scheduleStorageCleanupBatch");
  });

  it("runs from waitUntil without an HTTP request and stays batch-bounded", async () => {
    let scheduled: Promise<unknown> | undefined;
    const info = vi.fn();
    const drain = vi.fn(async () => drainResult({ claimed: 2, deleted: 2 }));
    scheduleStorageCleanupBatch({
      context: {
        waitUntil(promise) {
          scheduled = promise;
        },
      },
      bucket,
      scheduledTime: 1_000,
      cron: "*/5 * * * *",
      drain,
      countBacklog: vi.fn(async () => 0),
      logger: { info, error: vi.fn() },
    });

    await expect(scheduled).resolves.toMatchObject({
      event: "storage_cleanup.batch",
      deleted: 2,
      backlog: 0,
    });
    expect(drain).toHaveBeenCalledWith({
      bucket,
      limit: storageCleanupBatchSize,
    });
    expect(info).toHaveBeenCalledOnce();
  });

  it("reports backlog and fixed per-cause failure counts", async () => {
    const failureCounts = createStorageCleanupFailureCounts();
    failureCounts[storageCleanupFailureCodes.r2Delete] = 1;
    const observation = await runStorageCleanupBatch({
      bucket,
      scheduledTime: 2_000,
      cron: "*/5 * * * *",
      drain: vi.fn(async () => drainResult({
        claimed: 3,
        deleted: 2,
        deferred: 1,
        failureCounts,
      })),
      countBacklog: vi.fn(async () => 17),
    });

    expect(observation).toMatchObject({
      claimed: 3,
      deleted: 2,
      deferred: 1,
      backlog: 17,
      failureCounts: { R2_DELETE_FAILED: 1 },
    });
  });

  it("logs a bounded observation and fails the Cron event on cleanup errors", async () => {
    const failureCounts = createStorageCleanupFailureCounts();
    failureCounts[storageCleanupFailureCodes.databaseFinalize] = 1;
    const error = vi.fn();
    await expect(
      observeStorageCleanupBatch({
        bucket,
        scheduledTime: 3_000,
        cron: "*/5 * * * *",
        drain: vi.fn(async () => drainResult({
          claimed: 1,
          deferred: 1,
          failureCounts,
        })),
        countBacklog: vi.fn(async () => 1),
        logger: { info: vi.fn(), error },
      }),
    ).rejects.toThrow(storageCleanupBatchFailureCode);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('"DATABASE_FINALIZE_FAILED":1'),
    );
  });

  it("counts backlog-query failures under a fixed error code", async () => {
    const observation = await runStorageCleanupBatch({
      bucket,
      scheduledTime: 4_000,
      cron: "*/5 * * * *",
      drain: vi.fn(async () => drainResult()),
      countBacklog: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    });
    expect(observation.failureCounts.BACKLOG_COUNT_FAILED).toBe(1);
  });

  it("leases each row to only one concurrent invocation", async () => {
    let findCalls = 0;
    let releaseFinds: (() => void) | undefined;
    const bothFound = new Promise<void>((resolve) => {
      releaseFinds = resolve;
    });
    let leaseId: string | null = null;
    const candidate = {
      id: "cleanup-id",
      fileId: "file-id",
      objectKey: "object-key",
    };
    const prisma = {
      storageCleanup: {
        findMany: vi.fn(async () => {
          findCalls++;
          if (findCalls === 2) releaseFinds?.();
          await bothFound;
          return [candidate];
        }),
        updateMany: vi.fn(async ({ data }: { data: { leaseId: string } }) => {
          if (leaseId !== null) return { count: 0 };
          leaseId = data.leaseId;
          return { count: 1 };
        }),
      },
    } as never;

    const [first, second] = await Promise.all([
      claimDueStorageCleanups({ prisma }),
      claimDueStorageCleanups({ prisma }),
    ]);
    expect([...first, ...second]).toHaveLength(1);
    expect(leaseId).toBeTruthy();
  });
});
