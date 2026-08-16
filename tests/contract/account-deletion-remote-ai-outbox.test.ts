import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAiJob,
  enqueueAiRemoteJobCleanup,
  enqueueUserRemoteAiJobCleanups,
  setDbProvider,
} from "@beutl/db";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

vi.mock("../../packages/api/src/ai/openrouter", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../../packages/api/src/ai/openrouter")
  >();
  return { ...original, getVideoJob: vi.fn() };
});

import { getVideoJob } from "../../packages/api/src/ai/openrouter";
import { reconcileDeletedAccountRemoteJobs } from "../../packages/api/src/ai/remote-job-cleanup";

describe("deleted-account remote AI job outbox", () => {
  let store: ReturnType<typeof createInMemoryPrisma>;

  beforeEach(() => {
    vi.clearAllMocks();
    store = createInMemoryPrisma();
    setDbProvider(async () => store.prisma as never);
  });

  it("survives the User cascade and honors lease, pending, error, and terminal states", async () => {
    const now = new Date("2026-08-11T00:00:00.000Z");
    await createAiJob({
      userId: "user-1",
      kind: "video",
      provider: "openrouter",
      providerJobId: "provider-video-1",
      status: "running",
      usageUnits: 160,
    });

    await expect(
      enqueueUserRemoteAiJobCleanups({
        userId: "user-1",
        now,
        prisma: store.prisma as never,
      }),
    ).resolves.toBe(1);
    const cleanupKey = "openrouter:provider-video-1";
    expect(store.state.aiRemoteJobCleanups.get(cleanupKey)).toMatchObject({
      provider: "openrouter",
      providerJobId: "provider-video-1",
      attempts: 0,
      leaseExpiresAt: null,
    });

    // AiJob is User-owned and cascades; the cleanup row deliberately is not.
    store.state.aiJobs.clear();
    expect(store.state.aiRemoteJobCleanups.has(cleanupKey)).toBe(true);

    const leased = store.state.aiRemoteJobCleanups.get(cleanupKey)!;
    leased.leaseExpiresAt = new Date(now.getTime() + 60_000);
    await expect(reconcileDeletedAccountRemoteJobs(now)).resolves.toEqual({
      inspected: 0,
      completed: 0,
      pending: 0,
      errors: 0,
    });
    expect(getVideoJob).not.toHaveBeenCalled();

    leased.leaseExpiresAt = null;
    vi.mocked(getVideoJob).mockResolvedValue({
      id: "provider-video-1",
      status: "pending",
    });
    await expect(reconcileDeletedAccountRemoteJobs(now)).resolves.toEqual({
      inspected: 1,
      completed: 0,
      pending: 1,
      errors: 0,
    });
    const afterPending = store.state.aiRemoteJobCleanups.get(cleanupKey)!;
    expect(afterPending).toMatchObject({ attempts: 1, lastError: null });
    expect(afterPending.leaseExpiresAt).toBeNull();
    expect(afterPending.notBefore).toEqual(
      new Date(now.getTime() + 5 * 60_000),
    );

    await expect(
      reconcileDeletedAccountRemoteJobs(
        new Date(afterPending.notBefore.getTime() - 1),
      ),
    ).resolves.toMatchObject({ inspected: 0 });

    vi.mocked(getVideoJob).mockRejectedValueOnce(
      new Error("OpenRouter temporarily unavailable"),
    );
    await expect(
      reconcileDeletedAccountRemoteJobs(afterPending.notBefore),
    ).resolves.toEqual({
      inspected: 1,
      completed: 0,
      pending: 0,
      errors: 1,
    });
    const afterError = store.state.aiRemoteJobCleanups.get(cleanupKey)!;
    expect(afterError).toMatchObject({
      attempts: 2,
      lastError: "OpenRouter temporarily unavailable",
    });
    expect(afterError.notBefore).toEqual(
      new Date(afterPending.notBefore.getTime() + 10 * 60_000),
    );

    vi.mocked(getVideoJob).mockResolvedValueOnce({
      id: "provider-video-1",
      status: "completed",
    });
    await expect(
      reconcileDeletedAccountRemoteJobs(afterError.notBefore),
    ).resolves.toEqual({
      inspected: 1,
      completed: 1,
      pending: 0,
      errors: 0,
    });
    expect(store.state.aiRemoteJobCleanups.has(cleanupKey)).toBe(false);
  });

  it("drops a stale cleanup intent without touching a provider job that has a live owner", async () => {
    const now = new Date("2026-08-11T00:00:00.000Z");
    await createAiJob({
      userId: "user-1",
      kind: "video",
      provider: "openrouter",
      providerJobId: "provider-video-owned",
      status: "running",
      usageUnits: 160,
    });
    await enqueueAiRemoteJobCleanup({
      provider: "openrouter",
      providerJobId: "provider-video-owned",
      now,
    });

    await expect(reconcileDeletedAccountRemoteJobs(now)).resolves.toEqual({
      inspected: 1,
      completed: 1,
      pending: 0,
      errors: 0,
    });
    expect(getVideoJob).not.toHaveBeenCalled();
    expect(
      store.state.aiRemoteJobCleanups.has("openrouter:provider-video-owned"),
    ).toBe(false);
  });
});
