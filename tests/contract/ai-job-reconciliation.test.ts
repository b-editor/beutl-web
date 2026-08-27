import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimAiJobForFinalization,
  createAiJob,
  getCreditAccount,
  getAiJobById,
  registerAiStorageCleanup,
  setDbProvider,
  setQueuedAiJobRunning,
  upsertSubscription,
} from "@beutl/db";
import {
  AiOutputCommitConflictError,
  MAX_AI_TEXT_RESULT_BYTES,
  createReservedAiJob,
  failAiJobAndRefundUsage,
  reconcileAiJobs,
  reconcileAiStorageCleanups,
  saveAiJsonResult,
  saveAiImage,
  readAiJsonResult,
  setR2BucketProvider,
  synchronizeAiVideoJob,
} from "@beutl/api";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

vi.mock("../../packages/api/src/ai/openrouter-video", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../../packages/api/src/ai/openrouter-video")
  >();
  return { ...original, getVideoJob: vi.fn() };
});
vi.mock("../../packages/api/src/ai/openrouter", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../../packages/api/src/ai/openrouter")
  >();
  return {
    ...original,
    downloadVideoContent: vi.fn(),
  };
});

import {
  downloadVideoContent,
  InvalidAiProviderOutputError,
} from "../../packages/api/src/ai/openrouter";
import { getVideoJob } from "../../packages/api/src/ai/openrouter-video";

const USER_ID = "user-1";
const PERIOD_START = new Date("2026-08-01T00:00:00.000Z");
const PERIOD_END = new Date("2099-09-01T00:00:00.000Z");

describe("AI job reconciliation", () => {
  let store: ReturnType<typeof createInMemoryPrisma>;
  let putObject: ReturnType<typeof vi.fn>;
  let deleteObject: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    store = createInMemoryPrisma();
    setDbProvider(async () => store.prisma as never);
    putObject = vi.fn().mockResolvedValue(undefined);
    deleteObject = vi.fn().mockResolvedValue(undefined);
    setR2BucketProvider(() => ({
      put: putObject,
      delete: deleteObject,
    }));
    await upsertSubscription({
      userId: USER_ID,
      stripeSubscriptionId: "sub_1",
      status: "active",
      planId: "pro",
      billingOfferId: "offer_pro_test",
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: PERIOD_END,
      cancelAt: null,
    });
  });

  it("refunds an abandoned synchronous operation", async () => {
    const reservation = await createReservedAiJob({
      userId: USER_ID,
      kind: "image",
      provider: "openrouter",
      status: "running",
      usageUnits: 20,
    });
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) return;

    const now = new Date("2026-08-08T12:00:00.000Z");
    const job = store.state.aiJobs.get(reservation.job.id)!;
    job.createdAt = new Date(now.getTime() - 31 * 60 * 1000);
    job.updatedAt = job.createdAt;

    const result = await reconcileAiJobs(now);

    expect(result).toMatchObject({ inspected: 1, failed: 1, errors: 0 });
    expect(store.state.aiJobs.get(job.id)?.status).toBe("failed");
    expect((await getCreditAccount({ userId: USER_ID })).monthlyUsageUsed).toBe(0);
    expect(
      store.state.creditTransactions.filter((item) => item.kind === "refund"),
    ).toHaveLength(1);
  });

  it("returns one reservation and a typed conflict for parallel idempotent bodies", async () => {
    const reserve = (requestFingerprint: string) =>
      createReservedAiJob({
        userId: USER_ID,
        kind: "image",
        provider: "openrouter",
        status: "running",
        usageUnits: 20,
        idempotencyKeyHash: "parallel-idempotency-key",
        requestFingerprint,
      });

    const results = await Promise.all([
      reserve("first-body"),
      reserve("second-body"),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      {
        ok: false,
        errorCode: "aiRequestChanged",
        status: 409,
      },
    ]);
    expect(store.state.aiJobs.size).toBe(1);
    expect(
      store.state.creditTransactions.filter((item) => item.kind === "usage"),
    ).toHaveLength(1);
  });

  it("maps a unique idempotency reservation collision to a typed conflict", async () => {
    const idempotencyKeyHash = "p2002-idempotency-key";
    const originalFingerprint = "original-body";
    await createAiJob({
      userId: USER_ID,
      kind: "image",
      provider: "openrouter",
      status: "running",
      usageUnits: 20,
      idempotencyKeyHash,
      requestFingerprint: originalFingerprint,
    });

    const findFirst = store.prisma.aiJob.findFirst.bind(store.prisma.aiJob);
    let lookupCount = 0;
    vi.spyOn(store.prisma.aiJob, "findFirst").mockImplementation(
      async (args) => {
        // The transaction's snapshot misses the row, then the unique index
        // rejects the insert. The fallback lookup sees the committed winner.
        lookupCount++;
        if (lookupCount === 1) return null;
        return await findFirst(args);
      },
    );

    const result = await createReservedAiJob({
      userId: USER_ID,
      kind: "image",
      provider: "openrouter",
      status: "running",
      usageUnits: 20,
      idempotencyKeyHash,
      requestFingerprint: "conflicting-body",
    });

    expect(result).toEqual({
      ok: false,
      errorCode: "aiRequestChanged",
      status: 409,
    });
    expect(lookupCount).toBeGreaterThanOrEqual(2);
    expect(
      store.state.creditTransactions.filter((item) => item.kind === "usage"),
    ).toHaveLength(0);
  });

  it("keeps a unique idempotency collision recoverable when the winner is not yet readable", async () => {
    const idempotencyKeyHash = "p2002-unreadable-winner-key";
    await createAiJob({
      userId: USER_ID,
      kind: "image",
      provider: "openrouter",
      status: "running",
      usageUnits: 20,
      idempotencyKeyHash,
      requestFingerprint: "original-body",
    });

    // Model a CockroachDB unique-index conflict whose follow-up read is still
    // behind the committing winner. The client must retain the key and retry,
    // rather than seeing a raw P2002 and rotating to a second charge.
    vi.spyOn(store.prisma.aiJob, "findFirst").mockResolvedValue(null);

    await expect(createReservedAiJob({
      userId: USER_ID,
      kind: "image",
      provider: "openrouter",
      status: "running",
      usageUnits: 20,
      idempotencyKeyHash,
      requestFingerprint: "conflicting-body",
    })).resolves.toEqual({
      ok: false,
      errorCode: "aiRequestChanged",
      status: 409,
    });
    expect(
      store.state.creditTransactions.filter((item) => item.kind === "usage"),
    ).toHaveLength(0);
  });

  it("refunds an unknown video submission after the provider job window", async () => {
    const reservation = await createReservedAiJob({
      userId: USER_ID,
      kind: "video",
      provider: "openrouter",
      status: "queued",
      usageUnits: 200,
      activeJobLimit: 1,
    });
    if (!reservation.ok) throw new Error("AI job reservation failed");
    const now = new Date("2026-08-08T12:00:00.000Z");
    const job = store.state.aiJobs.get(reservation.job.id)!;
    job.createdAt = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    job.updatedAt = job.createdAt;

    const result = await reconcileAiJobs(now);

    expect(result).toMatchObject({ inspected: 1, pending: 0, failed: 1 });
    expect(store.state.aiJobs.get(job.id)).toMatchObject({
      status: "failed",
      providerJobId: null,
    });
    expect((await getCreditAccount({ userId: USER_ID })).monthlyUsageUsed).toBe(0);
    expect(
      store.state.creditTransactions.filter((item) => item.kind === "refund"),
    ).toHaveLength(1);
    expect(vi.mocked(getVideoJob)).not.toHaveBeenCalled();
  });

  it("keeps an ambiguous video submission reserved while a callback can arrive", async () => {
    const reservation = await createReservedAiJob({
      userId: USER_ID,
      kind: "video",
      provider: "openrouter",
      status: "queued",
      usageUnits: 200,
      activeJobLimit: 1,
    });
    if (!reservation.ok) throw new Error("AI job reservation failed");
    const now = new Date("2026-08-08T12:00:00.000Z");
    const job = store.state.aiJobs.get(reservation.job.id)!;
    job.createdAt = new Date(now.getTime() - 5 * 60 * 1000);
    job.updatedAt = job.createdAt;

    const result = await reconcileAiJobs(now);

    expect(result).toMatchObject({ inspected: 1, pending: 1, failed: 0 });
    expect(store.state.aiJobs.get(job.id)?.status).toBe("queued");
    expect((await getCreditAccount({ userId: USER_ID })).monthlyUsageUsed).toBe(200);
  });

  it("rotates a pending video from its current status after synchronization", async () => {
    const reservation = await createReservedAiJob({
      userId: USER_ID,
      kind: "video",
      provider: "openrouter",
      status: "queued",
      usageUnits: 200,
    });
    if (!reservation.ok) throw new Error("AI job reservation failed");
    await setQueuedAiJobRunning({
      jobId: reservation.job.id,
      providerJobId: "provider-video-current-status",
    });
    const now = new Date("2026-08-08T12:00:00.000Z");
    const job = store.state.aiJobs.get(reservation.job.id)!;
    job.createdAt = new Date(now.getTime() - 5 * 60 * 1000);
    job.updatedAt = new Date(now.getTime() - 2 * 60 * 1000);
    vi.mocked(getVideoJob).mockResolvedValue({
      id: "provider-video-current-status",
      status: "in_progress",
    });

    const result = await reconcileAiJobs(now);

    expect(result).toMatchObject({ pending: 1, failed: 0, errors: 0 });
    expect(store.state.aiJobs.get(job.id)?.status).toBe("running");
  });

  it("does not refund an unknown submission after a callback attaches its provider ID", async () => {
    const reservation = await createReservedAiJob({
      userId: USER_ID,
      kind: "video",
      provider: "openrouter",
      status: "queued",
      usageUnits: 200,
      activeJobLimit: 1,
    });
    if (!reservation.ok) throw new Error("AI job reservation failed");
    await setQueuedAiJobRunning({
      jobId: reservation.job.id,
      providerJobId: "provider-callback-race",
    });

    await failAiJobAndRefundUsage({
      userId: USER_ID,
      aiJobId: reservation.job.id,
      error: "stale unknown-submission timeout",
      expectedProviderJobId: null,
    });

    expect(store.state.aiJobs.get(reservation.job.id)).toMatchObject({
      status: "running",
      providerJobId: "provider-callback-race",
    });
    expect(await getCreditAccount({ userId: USER_ID })).toMatchObject({
      monthlyUsageUsed: 200,
    });
    expect(
      store.state.creditTransactions.filter((item) => item.kind === "refund"),
    ).toHaveLength(0);
  });

  it("switches to provider synchronization when a callback wins the timeout CAS", async () => {
    const reservation = await createReservedAiJob({
      userId: USER_ID,
      kind: "video",
      provider: "openrouter",
      status: "queued",
      usageUnits: 200,
      activeJobLimit: 1,
    });
    if (!reservation.ok) throw new Error("AI job reservation failed");
    const now = new Date("2026-08-08T12:00:00.000Z");
    const job = store.state.aiJobs.get(reservation.job.id)!;
    job.createdAt = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    job.updatedAt = job.createdAt;
    vi.mocked(getVideoJob).mockResolvedValue({
      id: "provider-callback-race",
      status: "in_progress",
    });

    const updateMany = store.prisma.aiJob.updateMany.bind(
      store.prisma.aiJob,
    );
    vi.spyOn(store.prisma.aiJob, "updateMany").mockImplementationOnce(
      async (args: any) => {
        const current = store.state.aiJobs.get(job.id)!;
        current.providerJobId = "provider-callback-race";
        current.status = "running";
        return await updateMany(args);
      },
    );

    const result = await reconcileAiJobs(now);

    expect(result).toMatchObject({ pending: 1, failed: 0, errors: 0 });
    expect(vi.mocked(getVideoJob)).toHaveBeenCalledWith(
      "provider-callback-race",
    );
    expect(store.state.aiJobs.get(job.id)).toMatchObject({
      status: "running",
      providerJobId: "provider-callback-race",
    });
    expect((await getCreditAccount({ userId: USER_ID })).monthlyUsageUsed)
      .toBe(200);
    expect(
      store.state.creditTransactions.filter((item) => item.kind === "refund"),
    ).toHaveLength(0);
  });

  it("finalizes a completed video even when no client polls it", async () => {
    const reservation = await createReservedAiJob({
      userId: USER_ID,
      kind: "video",
      provider: "openrouter",
      status: "queued",
      usageUnits: 200,
      activeJobLimit: 1,
    });
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) return;
    await setQueuedAiJobRunning({
      jobId: reservation.job.id,
      providerJobId: "provider-video-1",
    });

    const now = new Date("2026-08-08T12:00:00.000Z");
    const job = store.state.aiJobs.get(reservation.job.id)!;
    job.createdAt = new Date(now.getTime() - 5 * 60 * 1000);
    job.updatedAt = job.createdAt;
    vi.mocked(getVideoJob).mockResolvedValue({
      id: "provider-video-1",
      status: "completed",
      unsignedUrls: ["https://example.com/video.mp4"],
    });
    vi.mocked(downloadVideoContent).mockResolvedValue({
      bytes: new Uint8Array([0, 1, 2, 3]).buffer,
      mimeType: "video/mp4",
      extension: "mp4",
    });

    const result = await reconcileAiJobs(now);

    expect(result).toMatchObject({ inspected: 1, succeeded: 1, errors: 0 });
    const output = [...store.state.files.values()][0];
    expect(store.state.aiJobs.get(job.id)).toMatchObject({
      status: "succeeded",
      resultFileId: output.id,
    });
    expect(output.objectKey).toMatch(
      new RegExp(`^ai/video/${job.id}/[0-9a-f-]+$`),
    );
    expect((await getCreditAccount({ userId: USER_ID })).monthlyUsageUsed).toBe(200);
    expect(
      store.state.creditTransactions.filter((item) => item.kind === "refund"),
    ).toHaveLength(0);
  });

  it("fails and refunds a completed provider job with invalid video output", async () => {
    const reservation = await createReservedAiJob({
      userId: USER_ID,
      kind: "video",
      provider: "openrouter",
      status: "queued",
      usageUnits: 200,
      activeJobLimit: 1,
    });
    if (!reservation.ok) throw new Error("AI job reservation failed");
    await setQueuedAiJobRunning({
      jobId: reservation.job.id,
      providerJobId: "provider-invalid-video",
    });
    const now = new Date("2026-08-08T12:00:00.000Z");
    const job = store.state.aiJobs.get(reservation.job.id)!;
    job.createdAt = new Date(now.getTime() - 7 * 60 * 60 * 1000);
    job.updatedAt = job.createdAt;
    vi.mocked(getVideoJob).mockResolvedValue({
      id: "provider-invalid-video",
      status: "completed",
    });
    vi.mocked(downloadVideoContent).mockRejectedValue(
      new InvalidAiProviderOutputError("invalid video"),
    );

    const result = await reconcileAiJobs(now);

    expect(result).toMatchObject({ failed: 1, pending: 0, errors: 0 });
    expect(store.state.aiJobs.get(job.id)?.status).toBe("failed");
    expect((await getCreditAccount({ userId: USER_ID })).monthlyUsageUsed)
      .toBe(0);
    expect(
      store.state.creditTransactions.filter((item) => item.kind === "refund"),
    ).toHaveLength(1);
  });

  it("retries finalization after an abandoned finalizer lease expires", async () => {
    const reservation = await createReservedAiJob({
      userId: USER_ID,
      kind: "video",
      provider: "openrouter",
      status: "queued",
      usageUnits: 200,
      activeJobLimit: 1,
    });
    if (!reservation.ok) throw new Error("AI job reservation failed");
    await setQueuedAiJobRunning({
      jobId: reservation.job.id,
      providerJobId: "provider-video-abandoned-finalizer",
    });
    const claimedAt = new Date();
    const firstClaim = await claimAiJobForFinalization({
      jobId: reservation.job.id,
      now: claimedAt,
      leaseExpiresAt: new Date(claimedAt.getTime() + 1_000),
    });
    expect(firstClaim.claimed).toBe(true);
    const staleFinalizing = { ...store.state.aiJobs.get(reservation.job.id)! };
    vi.mocked(getVideoJob).mockResolvedValue({
      id: "provider-video-abandoned-finalizer",
      status: "completed",
    });
    vi.mocked(downloadVideoContent).mockResolvedValue({
      bytes: new Uint8Array([0, 1, 2, 3]).buffer,
      mimeType: "video/mp4",
      extension: "mp4",
    });

    const current = await synchronizeAiVideoJob({
      job: staleFinalizing,
      now: new Date(claimedAt.getTime() + 1_000),
    });

    expect(current).toMatchObject({ status: "succeeded" });
    expect(vi.mocked(getVideoJob)).toHaveBeenCalledOnce();
    expect(vi.mocked(downloadVideoContent)).toHaveBeenCalledOnce();
    expect(store.state.files.size).toBe(1);
  });

  it.each(["failed", "cancelled", "expired"] as const)(
    "refunds a %s video exactly once",
    async (providerStatus) => {
      const reservation = await createReservedAiJob({
        userId: USER_ID,
        kind: "video",
        provider: "openrouter",
        status: "queued",
        usageUnits: 200,
        activeJobLimit: 1,
      });
      expect(reservation.ok).toBe(true);
      if (!reservation.ok) return;
      await setQueuedAiJobRunning({
        jobId: reservation.job.id,
        providerJobId: "provider-video-1",
      });

      const now = new Date("2026-08-08T12:00:00.000Z");
      const job = store.state.aiJobs.get(reservation.job.id)!;
      job.createdAt = new Date(now.getTime() - 5 * 60 * 1000);
      job.updatedAt = job.createdAt;
      vi.mocked(getVideoJob).mockResolvedValue({
        id: "provider-video-1",
        status: providerStatus,
        error: `provider ${providerStatus}`,
      });

      await reconcileAiJobs(now);
      await reconcileAiJobs(new Date(now.getTime() + 5 * 60 * 1000));

      expect(store.state.aiJobs.get(job.id)?.status).toBe("failed");
      expect(
        (await getCreditAccount({ userId: USER_ID })).monthlyUsageUsed,
      ).toBe(0);
      expect(
        store.state.creditTransactions.filter(
          (item) => item.kind === "refund",
        ),
      ).toHaveLength(1);
    },
  );

  it("does not refund a stale terminal poll after another poll takes ownership", async () => {
    const reservation = await createReservedAiJob({
      userId: USER_ID,
      kind: "video",
      provider: "openrouter",
      status: "queued",
      usageUnits: 200,
    });
    if (!reservation.ok) throw new Error("AI job reservation failed");
    await setQueuedAiJobRunning({
      jobId: reservation.job.id,
      providerJobId: "provider-video-poll-takeover",
    });
    const snapshot = { ...store.state.aiJobs.get(reservation.job.id)! };
    vi.mocked(getVideoJob).mockImplementationOnce(async () => {
      const current = store.state.aiJobs.get(reservation.job.id)!;
      current.providerPollLeaseExpiresAt = new Date(
        current.providerPollLeaseExpiresAt!.getTime() + 1,
      );
      return {
        id: "provider-video-poll-takeover",
        status: "failed",
      };
    });

    const current = await synchronizeAiVideoJob({ job: snapshot });

    expect(current).toMatchObject({ status: "running" });
    expect((await getCreditAccount({ userId: USER_ID })).monthlyUsageUsed)
      .toBe(200);
    expect(
      store.state.creditTransactions.filter((item) => item.kind === "refund"),
    ).toHaveLength(0);
  });

  it("does not refund from a stale snapshot after a fresh finalizer claims the job", async () => {
    const reservation = await createReservedAiJob({
      userId: USER_ID,
      kind: "video",
      provider: "openrouter",
      status: "queued",
      usageUnits: 200,
    });
    if (!reservation.ok) throw new Error("AI job reservation failed");
    await setQueuedAiJobRunning({
      jobId: reservation.job.id,
      providerJobId: "provider-video-stale",
    });
    const staleSnapshot = {
      ...store.state.aiJobs.get(reservation.job.id)!,
    };
    const now = new Date();
    const claim = await claimAiJobForFinalization({
      jobId: reservation.job.id,
      now,
      leaseExpiresAt: new Date(now.getTime() + 10 * 60 * 1000),
    });
    expect(claim.claimed).toBe(true);
    vi.mocked(getVideoJob).mockResolvedValue({
      id: "provider-video-stale",
      status: "failed",
      error: "stale provider response",
    });

    const current = await synchronizeAiVideoJob({
      job: staleSnapshot,
      now: new Date(now.getTime() + 60 * 1000),
    });

    expect(current).toMatchObject({
      status: "finalizing",
      finalizationToken: claim.finalizationToken,
    });
    expect((await getCreditAccount({ userId: USER_ID })).monthlyUsageUsed).toBe(200);
    expect(
      store.state.creditTransactions.filter((item) => item.kind === "refund"),
    ).toHaveLength(0);
  });

  it("keeps an expired-by-age video pending while its finalization lease is fresh", async () => {
    const reservation = await createReservedAiJob({
      userId: USER_ID,
      kind: "video",
      provider: "openrouter",
      status: "queued",
      usageUnits: 200,
    });
    if (!reservation.ok) throw new Error("AI job reservation failed");
    await setQueuedAiJobRunning({
      jobId: reservation.job.id,
      providerJobId: "provider-video-fresh-lease",
    });
    const claimedAt = new Date();
    const claim = await claimAiJobForFinalization({
      jobId: reservation.job.id,
      now: claimedAt,
      leaseExpiresAt: new Date(claimedAt.getTime() + 10 * 60 * 1000),
    });
    expect(claim.claimed).toBe(true);
    const job = store.state.aiJobs.get(reservation.job.id)!;
    const reconcileAt = new Date(claimedAt.getTime() + 2 * 60 * 1000);
    job.createdAt = new Date(reconcileAt.getTime() - 7 * 60 * 60 * 1000);

    const result = await reconcileAiJobs(reconcileAt);

    expect(result).toMatchObject({ inspected: 1, pending: 1, failed: 0 });
    expect(store.state.aiJobs.get(job.id)?.status).toBe("finalizing");
    expect(
      store.state.creditTransactions.filter((item) => item.kind === "refund"),
    ).toHaveLength(0);
    expect(vi.mocked(getVideoJob)).not.toHaveBeenCalled();
  });

  it("does not expire or refund a video while a concurrent provider poll owns the lease", async () => {
    const reservation = await createReservedAiJob({
      userId: USER_ID,
      kind: "video",
      provider: "openrouter",
      status: "queued",
      usageUnits: 200,
    });
    if (!reservation.ok) throw new Error("AI job reservation failed");
    await setQueuedAiJobRunning({
      jobId: reservation.job.id,
      providerJobId: "provider-video-concurrent-poll",
    });

    const reconcileAt = new Date();
    const job = store.state.aiJobs.get(reservation.job.id)!;
    job.createdAt = new Date(
      reconcileAt.getTime() - 7 * 60 * 60 * 1000,
    );
    job.updatedAt = job.createdAt;
    const findMany = store.prisma.aiJob.findMany.bind(store.prisma.aiJob);
    let releaseReconciliationScan!: () => void;
    let markReconciliationScanReady!: () => void;
    const reconciliationScanReady = new Promise<void>((resolve) => {
      markReconciliationScanReady = resolve;
    });
    const reconciliationScanBlocked = new Promise<void>((resolve) => {
      releaseReconciliationScan = resolve;
    });
    vi.spyOn(store.prisma.aiJob, "findMany").mockImplementationOnce(
      async (args: any) => {
        const staleJobs = await findMany(args);
        markReconciliationScanReady();
        await reconciliationScanBlocked;
        return staleJobs;
      },
    );

    let finishProviderPoll!: () => void;
    vi.mocked(getVideoJob).mockImplementationOnce(
      () => new Promise((resolve) => {
        finishProviderPoll = () => resolve({
          id: "provider-video-concurrent-poll",
          status: "in_progress",
        });
      }),
    );

    const expiringReconciliation = reconcileAiJobs(reconcileAt);
    await reconciliationScanReady;
    const concurrentPoll = synchronizeAiVideoJob({
      job: { ...job },
      now: reconcileAt,
    });
    await vi.waitFor(() => {
      expect(vi.mocked(getVideoJob)).toHaveBeenCalledOnce();
    });
    const activePollLease = store.state.aiJobs.get(job.id)
      ?.providerPollLeaseExpiresAt;
    expect(activePollLease).toBeInstanceOf(Date);

    releaseReconciliationScan();
    const result = await expiringReconciliation;

    expect(result).toMatchObject({
      inspected: 1,
      pending: 1,
      failed: 0,
    });
    expect(store.state.aiJobs.get(job.id)).toMatchObject({
      status: "running",
      providerPollLeaseExpiresAt: activePollLease,
    });
    expect((await getCreditAccount({ userId: USER_ID })).monthlyUsageUsed)
      .toBe(200);
    expect(
      store.state.creditTransactions.filter((item) => item.kind === "refund"),
    ).toHaveLength(0);

    finishProviderPoll();
    await expect(concurrentPoll).resolves.toMatchObject({
      status: "running",
    });
  });

  it("compensates the losing finalizer's File and R2 object after takeover", async () => {
    const reservation = await createReservedAiJob({
      userId: USER_ID,
      kind: "video",
      provider: "openrouter",
      status: "queued",
      usageUnits: 200,
    });
    if (!reservation.ok) throw new Error("AI job reservation failed");
    await setQueuedAiJobRunning({
      jobId: reservation.job.id,
      providerJobId: "provider-video-race",
    });
    const snapshot = await getAiJobById({ jobId: reservation.job.id });
    if (!snapshot) throw new Error("AI job was not found");
    vi.mocked(getVideoJob).mockResolvedValue({
      id: "provider-video-race",
      status: "completed",
    });
    vi.mocked(downloadVideoContent).mockResolvedValue({
      bytes: new Uint8Array([0, 1, 2, 3]).buffer,
      mimeType: "video/mp4",
      extension: "mp4",
    });
    let finishPut!: () => void;
    const createFile = vi.spyOn(store.prisma.file, "create");
    const deleteFile = vi.spyOn(store.prisma.file, "delete");
    putObject.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        finishPut = resolve;
      }),
    );

    const firstFinalizer = synchronizeAiVideoJob({
      job: snapshot,
      now: new Date(),
    });
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledOnce());
    const firstToken = store.state.aiJobs.get(snapshot.id)?.finalizationToken;
    const firstLease = store.state.aiJobs.get(snapshot.id)
      ?.finalizationLeaseExpiresAt;
    expect(firstToken).toEqual(expect.any(String));
    const firstObjectKey = String(putObject.mock.calls[0]?.[0]);
    if (!firstLease) throw new Error("First finalizer has no lease");

    const takeover = await claimAiJobForFinalization({
      jobId: snapshot.id,
      now: firstLease,
      leaseExpiresAt: new Date(firstLease.getTime() + 10 * 60 * 1000),
    });
    expect(takeover).toMatchObject({
      claimed: true,
      finalizationToken: expect.not.stringMatching(firstToken!),
    });
    finishPut();
    const current = await firstFinalizer;

    expect(current).toMatchObject({
      status: "finalizing",
      finalizationToken: takeover.finalizationToken,
    });
    expect(store.state.files.size).toBe(0);
    expect(createFile).toHaveBeenCalledOnce();
    expect(deleteFile).toHaveBeenCalledOnce();
    expect(store.state.aiStorageCleanups.size).toBe(0);
    expect(deleteObject).toHaveBeenCalledWith(firstObjectKey);
    expect(
      store.state.creditTransactions.filter((item) => item.kind === "refund"),
    ).toHaveLength(0);
  });

  it("prevents a stale writer from committing after cleanup claims its intent", async () => {
    const reservation = await createReservedAiJob({
      userId: USER_ID,
      kind: "image",
      provider: "openrouter",
      status: "running",
      usageUnits: 20,
    });
    if (!reservation.ok) throw new Error("AI job reservation failed");
    let finishPut!: () => void;
    putObject.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        finishPut = resolve;
      }),
    );
    const write = saveAiImage({
      jobId: reservation.job.id,
      userId: USER_ID,
      bytes: Uint8Array.from([1, 2, 3]).buffer,
      mimeType: "image/png",
      filename: "stale.png",
    });
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledOnce());

    const reconciliation = await reconcileAiJobs(
      new Date(Date.now() + 16 * 60 * 1000),
    );
    expect(reconciliation).toMatchObject({
      cleanupInspected: 1,
      cleanupDeleted: 1,
    });
    finishPut();

    await expect(write).rejects.toBeInstanceOf(
      AiOutputCommitConflictError,
    );
    expect(store.state.files.size).toBe(0);
    expect(store.state.aiStorageCleanups.size).toBe(0);
    expect(deleteObject).toHaveBeenCalledTimes(2);
  });

  it("isolates a retry object from a stalled expired cleaner", async () => {
    const firstReservation = await createReservedAiJob({
      userId: USER_ID,
      kind: "image",
      provider: "openrouter",
      status: "running",
      usageUnits: 20,
    });
    const secondReservation = await createReservedAiJob({
      userId: USER_ID,
      kind: "image",
      provider: "openrouter",
      status: "running",
      usageUnits: 20,
    });
    if (!firstReservation.ok || !secondReservation.ok) {
      throw new Error("AI job reservation failed");
    }

    const now = new Date("2026-08-25T03:00:00.000Z");
    const oldKey = "ai/image/stalled-cleaner/orphan-a";
    await registerAiStorageCleanup({
      objectKey: oldKey,
      aiJobId: firstReservation.job.id,
      state: "cleanup",
      notBefore: now,
    });

    let releaseFirstDelete!: () => void;
    let deleteCalls = 0;
    deleteObject.mockImplementation((key: string) => {
      deleteCalls++;
      if (deleteCalls === 1) {
        return new Promise<void>((resolve) => {
          releaseFirstDelete = resolve;
        });
      }
      return Promise.resolve();
    });

    const firstCleaner = reconcileAiStorageCleanups(now);
    await vi.waitFor(() => expect(deleteObject).toHaveBeenCalledWith(oldKey));

    const leaseExpiry = new Date(
      now.getTime() + 5 * 60 * 1000,
    );
    const secondCleaner = await reconcileAiStorageCleanups(leaseExpiry);
    expect(secondCleaner).toMatchObject({ inspected: 1, deleted: 1, errors: 0 });

    const retry = await saveAiImage({
      jobId: secondReservation.job.id,
      userId: USER_ID,
      bytes: Uint8Array.from([9, 8, 7]).buffer,
      mimeType: "image/png",
      filename: "retry.png",
    });
    const newKey = retry.objectKey;
    expect(newKey).not.toBe(oldKey);
    expect(newKey).toMatch(new RegExp(`^ai/image/${secondReservation.job.id}/`));

    releaseFirstDelete();
    await expect(firstCleaner).resolves.toMatchObject({
      inspected: 1,
      deleted: 0,
      errors: 1,
    });
    expect(deleteObject.mock.calls.every(([key]) => key === oldKey)).toBe(true);
    expect([...store.state.files.values()].some((file) => file.objectKey === newKey)).toBe(true);
  });

  it("expires a recoverable text result without refunding its completed usage", async () => {
    const reservation = await createReservedAiJob({
      userId: USER_ID,
      kind: "stt",
      provider: "openrouter",
      status: "running",
      usageUnits: 5,
    });
    if (!reservation.ok) throw new Error("AI job reservation failed");

    const output = await saveAiJsonResult({
      jobId: reservation.job.id,
      userId: USER_ID,
      filename: "transcription.json",
      result: {
        version: 1,
        kind: "stt",
        segments: [{ start: 0, end: 1, text: "Recovered" }],
      },
    });
    const cleanup = [...store.state.aiStorageCleanups.values()][0];
    expect(cleanup).toBeDefined();

    const result = await reconcileAiJobs(
      new Date(cleanup.notBefore.getTime() + 1),
    );

    expect(result).toMatchObject({
      cleanupInspected: 1,
      cleanupDeleted: 1,
      cleanupErrors: 0,
    });
    expect(deleteObject).toHaveBeenCalledWith(output.objectKey);
    expect(store.state.files.has(output.id)).toBe(false);
    expect(store.state.aiJobs.get(reservation.job.id)).toMatchObject({
      status: "succeeded",
      resultFileId: null,
    });
    expect(store.state.aiStorageCleanups.size).toBe(0);
    expect(
      store.state.creditTransactions.filter((item) => item.kind === "refund"),
    ).toHaveLength(0);
    expect((await getCreditAccount({ userId: USER_ID })).monthlyUsageUsed).toBe(5);
  });

  it("detaches a text result that became shared without deleting its object", async () => {
    const reservation = await createReservedAiJob({
      userId: USER_ID,
      kind: "translation",
      provider: "openrouter",
      status: "running",
      usageUnits: 5,
    });
    if (!reservation.ok) throw new Error("AI job reservation failed");
    const output = await saveAiJsonResult({
      jobId: reservation.job.id,
      userId: USER_ID,
      filename: "translation.json",
      result: {
        version: 1,
        kind: "translation",
        targetLanguage: "ja",
        segments: [{ id: "line-1", text: "翻訳" }],
      },
    });
    const cleanup = [...store.state.aiStorageCleanups.values()][0];
    const findFile = store.prisma.file.findFirst.bind(store.prisma.file);
    vi.spyOn(store.prisma.file, "findFirst").mockImplementation(async (args) => {
      const file = await findFile(args);
      return file
        ? { ...file, Package: [{ id: "package-1" }] }
        : null;
    });

    const result = await reconcileAiJobs(
      new Date(cleanup.notBefore.getTime() + 1),
    );

    expect(result).toMatchObject({
      cleanupInspected: 1,
      cleanupDeleted: 0,
      cleanupErrors: 0,
    });
    expect(deleteObject).not.toHaveBeenCalled();
    expect(store.state.files.has(output.id)).toBe(true);
    expect(store.state.aiJobs.get(reservation.job.id)?.resultFileId).toBeNull();
    expect(store.state.aiStorageCleanups.size).toBe(0);
  });

  it("rejects an oversized text result before creating an R2 object", async () => {
    const reservation = await createReservedAiJob({
      userId: USER_ID,
      kind: "stt",
      provider: "openrouter",
      status: "running",
      usageUnits: 5,
    });
    if (!reservation.ok) throw new Error("AI job reservation failed");

    await expect(
      saveAiJsonResult({
        jobId: reservation.job.id,
        userId: USER_ID,
        filename: "oversized.json",
        result: { text: "x".repeat(MAX_AI_TEXT_RESULT_BYTES) },
      }),
    ).rejects.toThrow("storage size limit");

    expect(putObject).not.toHaveBeenCalled();
    expect(store.state.files.size).toBe(0);
    expect(store.state.aiStorageCleanups.size).toBe(0);
  });

  it("stops an oversized streamed text result before buffering the whole object", async () => {
    let cancelled = false;
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(6));
      },
      cancel() {
        cancelled = true;
      },
    });
    setR2BucketProvider(() => ({
      put: putObject,
      get: vi.fn().mockResolvedValue({ body: oversized }),
    }));

    await expect(readAiJsonResult({
      objectKey: "ai/json/oversized",
      maximumBytes: 10,
    })).rejects.toThrow("exceeds the size limit");
    expect(cancelled).toBe(true);
  });
});
