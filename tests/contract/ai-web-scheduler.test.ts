import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { getDb, runWithDbProvider, setDbProvider } from "@beutl/db";
import {
  getR2Bucket,
  runWithR2BucketProvider,
  setR2BucketProvider,
} from "../../packages/api/src/ai/r2-provider";

const reconcileAiJobs = vi.hoisted(() => vi.fn());
const prismaCalls = vi.hoisted(() => ({
  construct: vi.fn(),
  disconnect: vi.fn(async () => undefined),
}));
vi.mock("@prisma/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@prisma/client")>(),
  PrismaClient: class {
    constructor() { prismaCalls.construct(); }
    $transaction() { return undefined; }
    $disconnect() { return prismaCalls.disconnect(); }
  },
}));
vi.mock("../../packages/api/src/ai/reconcile-jobs", () => ({ reconcileAiJobs }));

import { reconcileWebAiJobs } from "../../apps/web/src/lib/ai-scheduled-reconciliation";

const emptyResult = {
  inspected: 0, succeeded: 0, failed: 0, pending: 0, errors: 0,
  cleanupInspected: 0, cleanupDeleted: 0, cleanupErrors: 0,
};

describe("Web Worker AI cron bindings", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs reconciliation with its own database and storage bindings", async () => {
    const bucket = { put: vi.fn(async () => undefined) };
    const env = {
      BEUTL_DATABASE_HYPERDRIVE: {
        connectionString: "postgresql://test:test@127.0.0.1:5432/scheduler_test",
      },
      BEUTL_R2_BUCKET: bucket,
    };
    const at = new Date("2026-09-23T00:05:00Z");
    reconcileAiJobs.mockImplementationOnce(async (now) => {
      if (now?.getTime() !== at.getTime()) throw new Error("scheduled time differs");
      if (typeof (await getDb()).$transaction !== "function") throw new Error("scheduled DB differs");
      if (getR2Bucket() !== bucket) throw new Error("scheduled bucket differs");
      return emptyResult;
    });

    const result = await reconcileWebAiJobs(env, at);
    expect(result).toEqual(emptyResult);
    expect(reconcileAiJobs).toHaveBeenCalledTimes(1);
  });

  it("constructs and disconnects one client across multiple database helpers", async () => {
    const env = {
      BEUTL_DATABASE_HYPERDRIVE: {
        connectionString: "postgresql://test:test@127.0.0.1:5432/scheduler_test",
      },
      BEUTL_R2_BUCKET: { put: vi.fn(async () => undefined) },
    };
    reconcileAiJobs.mockImplementationOnce(async () => {
      const first = await getDb();
      const second = await getDb();
      expect(first).toBe(second);
      return emptyResult;
    });

    await reconcileWebAiJobs(env, new Date("2026-09-23T00:05:00Z"));
    expect(prismaCalls.construct).toHaveBeenCalledTimes(1);
    expect(prismaCalls.disconnect).toHaveBeenCalledTimes(1);
  });

  it("disconnects the invocation client when reconciliation fails", async () => {
    const env = {
      BEUTL_DATABASE_HYPERDRIVE: {
        connectionString: "postgresql://test:test@127.0.0.1:5432/scheduler_test",
      },
      BEUTL_R2_BUCKET: { put: vi.fn(async () => undefined) },
    };
    reconcileAiJobs.mockImplementationOnce(async () => {
      await getDb();
      throw new Error("reconciliation failed");
    });

    await expect(reconcileWebAiJobs(env, new Date("2026-09-23T00:05:00Z")))
      .rejects.toThrow("reconciliation failed");
    expect(prismaCalls.construct).toHaveBeenCalledTimes(1);
    expect(prismaCalls.disconnect).toHaveBeenCalledTimes(1);
  });

  it("does not replace a concurrent Web request's providers", async () => {
    const defaultDb = {} as PrismaClient;
    const cronDb = {} as PrismaClient;
    const defaultBucket = { put: vi.fn(async () => undefined) };
    const cronBucket = { put: vi.fn(async () => undefined) };
    setDbProvider(async () => defaultDb);
    setR2BucketProvider(() => defaultBucket);

    const gate = Promise.withResolvers<void>();
    const scheduled = runWithDbProvider(async () => cronDb, () =>
      runWithR2BucketProvider(() => cronBucket, async () => {
        await gate.promise;
        expect(await getDb()).toBe(cronDb);
        expect(getR2Bucket()).toBe(cronBucket);
      }),
    );
    expect(await getDb()).toBe(defaultDb);
    expect(getR2Bucket()).toBe(defaultBucket);
    gate.resolve();
    await scheduled;
  });
});
