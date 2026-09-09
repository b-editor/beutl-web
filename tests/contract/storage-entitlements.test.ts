import { beforeEach, describe, expect, it, vi } from "vitest";
import { setDbProvider } from "@beutl/db";
import { getEntitlements, getStorageEntitlement } from "@beutl/api";
import { STORAGE_FREE_QUOTA_BYTES } from "@beutl/core";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const USER_ID = "storage-entitlement-user";
const GIB = 1024 * 1024 * 1024;
const PERIOD_START = new Date(Date.now() - 24 * 60 * 60 * 1_000);
const PERIOD_END = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000);

describe("storage entitlement for the desktop API", () => {
  let memory: ReturnType<typeof createInMemoryPrisma>;

  beforeEach(() => {
    memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
  });

  function file(id: string, size: number) {
    memory.state.files.set(id, {
      id,
      userId: USER_ID,
      objectKey: id,
      name: id,
      size,
      mimeType: "application/octet-stream",
      visibility: "PRIVATE",
      sha256: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
  }

  function subscribe(overrides: Record<string, unknown> = {}) {
    memory.state.subscriptions.set(`${USER_ID}:storage`, {
      userId: USER_ID,
      stripeSubscriptionId: "sub_storage",
      status: "active",
      planId: "storage",
      tier: "1tb",
      billingOfferId: "offer_storage",
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: PERIOD_END,
      cancelAtPeriodEnd: false,
      cancelAt: null,
      stripeEventId: null,
      stripeEventCreatedAt: null,
      stripeCanonicalObservedAt: null,
      stripeObservationRank: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    });
  }

  it("reports the free plan and its room for a fresh account", async () => {
    await expect(getStorageEntitlement(USER_ID)).resolves.toEqual({
      plan: null,
      quotaBytes: STORAGE_FREE_QUOTA_BYTES,
      usedBytes: 0,
      fileCount: 0,
      fileCountLimit: 10_000,
      canUpload: true,
      subscriptionStatus: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    });
  });

  it("reports the tier, usage, and the effective end for a subscriber", async () => {
    const cancelAt = new Date(PERIOD_END.getTime() - 60_000);
    subscribe({ cancelAtPeriodEnd: true, cancelAt });
    file("a", 3 * GIB);
    file("b", 5);

    const entitlement = await getStorageEntitlement(USER_ID);

    expect(entitlement.plan).toBe("1tb");
    expect(entitlement.quotaBytes).toBe(1024 * GIB);
    expect(entitlement.usedBytes).toBe(3 * GIB + 5);
    expect(entitlement.fileCount).toBe(2);
    expect(entitlement.canUpload).toBe(true);
    expect(entitlement.subscriptionStatus).toBe("active");
    expect(entitlement.currentPeriodStart).toBe(PERIOD_START.toISOString());
    expect(entitlement.currentPeriodEnd).toBe(cancelAt.toISOString());
    expect(entitlement.cancelAtPeriodEnd).toBe(true);
  });

  it("denies uploads at the quota line without touching the AI fields", async () => {
    file("full", STORAGE_FREE_QUOTA_BYTES);
    const [entitlement, ai] = await Promise.all([
      getStorageEntitlement(USER_ID),
      getEntitlements(USER_ID),
    ]);
    expect(entitlement.canUpload).toBe(false);
    expect(entitlement.usedBytes).toBe(STORAGE_FREE_QUOTA_BYTES);
    // The AI response is unchanged in shape: no storage key leaks in.
    expect(ai).not.toHaveProperty("storage");
    expect(ai.plan).toBeNull();
  });

  it("judges canUpload the way the start path does, with reservations counted", async () => {
    // 900 MiB stored plus a 200 MiB upload still in flight leave no room in
    // the free GiB, although the completed files alone would.
    file("stored", 900 * 1024 * 1024);
    memory.state.storageUploads.set("in-flight", {
      id: "in-flight",
      userId: USER_ID,
      objectKey: "in-flight",
      uploadId: "upload-1",
      name: "in-flight.bin",
      mimeType: "application/octet-stream",
      size: BigInt(200 * 1024 * 1024),
      partSize: 16 * 1024 * 1024,
      createdAt: new Date(),
      completedFileId: null,
      abandonedAt: null,
      startState: "active",
      creationLeaseUntil: null,
      creationLeaseToken: null,
      completionState: "idle",
      completionAttempts: 0,
      completionLastError: null,
      completionInterventionAt: null,
      completionRetryNotBefore: null,
      unknownProbeNotBefore: null,
      unknownProbeLeaseToken: null,
      completionRevision: 0,
      cleanupLeaseUntil: null,
      cleanupLeaseToken: null,
    } as never);

    const entitlement = await getStorageEntitlement(USER_ID);

    // The reported usage stays what is actually stored.
    expect(entitlement.usedBytes).toBe(900 * 1024 * 1024);
    expect(entitlement.fileCount).toBe(1);
    expect(entitlement.canUpload).toBe(false);

    // Slots count the same way: an upload in flight holds one.
    memory.state.storageUploads.set("in-flight", {
      ...memory.state.storageUploads.get("in-flight")!,
      size: BigInt(1),
    });
    // 9,999 completed files: the free limit of 10,000 has one slot left, and
    // the upload in flight is holding it.
    for (let index = 1; index < 9_999; index++) file(`f-${index}`, 1);
    expect((await getStorageEntitlement(USER_ID)).canUpload).toBe(false);
    memory.state.storageUploads.delete("in-flight");
    expect((await getStorageEntitlement(USER_ID)).canUpload).toBe(true);
  });

  it("excludes AI job results from the counted bytes", async () => {
    file("upload", 10);
    file("result", 1_000_000);
    memory.state.aiJobs.set("job", {
      id: "job",
      userId: USER_ID,
      resultFileId: "result",
      status: "completed",
    } as never);

    const entitlement = await getStorageEntitlement(USER_ID);

    expect(entitlement.usedBytes).toBe(10);
    expect(entitlement.fileCount).toBe(1);
  });

  it("does not open an interactive transaction", async () => {
    subscribe();
    const transaction = vi
      .spyOn(memory.prisma, "$transaction")
      .mockRejectedValue(new Error("no transaction expected"));
    await expect(getStorageEntitlement(USER_ID)).resolves.toMatchObject({ plan: "1tb" });
    expect(transaction).not.toHaveBeenCalled();
  });
});
