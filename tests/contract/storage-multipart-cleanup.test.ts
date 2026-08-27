import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimAiStorageCleanupForDeletion,
  enqueueStorageMultipartCleanup,
  STORAGE_MULTIPART_CLEANUP_LEASE_MILLISECONDS,
  STORAGE_MULTIPART_SETTLEMENT_GRACE_MILLISECONDS,
  STORAGE_MULTIPART_MAX_ATTEMPTS,
  recordStorageMultipartCleanupFailure,
  listStorageMultipartInterventions,
  resumeStorageMultipartIntervention,
  terminalizeStorageMultipartIntervention,
  setDbProvider,
} from "@beutl/db";
import {
  reconcileAiStorageCleanups,
  reconcileStorageMultipartCleanups,
  setR2BucketProvider,
} from "@beutl/api";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

describe("detached storage multipart cleanup", () => {
  let memory: ReturnType<typeof createInMemoryPrisma>;

  beforeEach(() => {
    vi.restoreAllMocks();
    memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
  });

  function addObjectCleanup(objectKey: string, notBefore: Date): void {
    memory.state.aiStorageCleanups.set(objectKey, {
      objectKey,
      aiJobId: null,
      leaseToken: null,
      state: "cleanup",
      notBefore,
      createdAt: new Date(notBefore),
      updatedAt: new Date(notBefore),
    });
  }

  it("retries a transient abort without deleting the object", async () => {
    const now = new Date("2026-08-27T00:00:00.000Z");
    await enqueueStorageMultipartCleanup({
      objectKey: "storage/user/upload",
      uploadId: "multipart-old",
      notBefore: now,
    });
    let attempts = 0;
    const deleteObject = vi.fn();
    setR2BucketProvider(() => ({
      delete: deleteObject,
      resumeMultipartUpload: () => ({
        uploadPart: vi.fn(),
        complete: vi.fn(),
        abort: async () => {
          attempts++;
          if (attempts === 1) throw new Error("temporary R2 outage");
        },
      }),
    }));

    await expect(reconcileStorageMultipartCleanups(now)).resolves.toEqual({
      inspected: 1,
      settled: 0,
      errors: 1,
    });
    const leaseUntil = new Date(
      now.getTime() + STORAGE_MULTIPART_CLEANUP_LEASE_MILLISECONDS,
    );
    await expect(
      reconcileStorageMultipartCleanups(new Date(leaseUntil.getTime() - 1)),
    ).resolves.toEqual({ inspected: 0, settled: 0, errors: 0 });
    await expect(reconcileStorageMultipartCleanups(leaseUntil)).resolves.toEqual({
      inspected: 1,
      settled: 1,
      errors: 0,
    });
    expect(attempts).toBe(2);
    expect(deleteObject).not.toHaveBeenCalled();
    expect(memory.state.storageMultipartCleanups.size).toBe(0);
  });

  it("never deletes a newer winner object after a delayed orphan abort", async () => {
    const objectKey = "storage/user/reused-key";
    const notBefore = new Date("2026-08-27T01:00:00.000Z");
    await enqueueStorageMultipartCleanup({
      objectKey,
      uploadId: "multipart-orphan",
      notBefore,
    });
    const winnerObjects = new Set([objectKey]);
    const deleteObject = vi.fn(async (key: string) => {
      winnerObjects.delete(key);
    });
    const head = vi.fn(async (key: string) =>
      winnerObjects.has(key) ? { size: 1_000 } : null);
    setR2BucketProvider(() => ({
      delete: deleteObject,
      head,
      resumeMultipartUpload: () => ({
        uploadPart: vi.fn(),
        complete: vi.fn(),
        abort: async () => {
          throw Object.assign(new Error("NoSuchUpload"), {
            code: "NoSuchUpload",
          });
        },
      }),
    }));

    await expect(reconcileStorageMultipartCleanups(notBefore)).resolves.toEqual({
      inspected: 1,
      settled: 1,
      errors: 0,
    });
    expect(head).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
    expect(winnerObjects.has(objectKey)).toBe(true);
  });

  it("keeps every handle when one object key has multiple multipart uploads", async () => {
    const now = new Date("2026-08-27T02:00:00.000Z");
    await Promise.all([
      enqueueStorageMultipartCleanup({
        objectKey: "storage/user/shared",
        uploadId: "multipart-a",
        notBefore: now,
      }),
      enqueueStorageMultipartCleanup({
        objectKey: "storage/user/shared",
        uploadId: "multipart-b",
        notBefore: now,
      }),
    ]);
    const aborted: string[] = [];
    setR2BucketProvider(() => ({
      resumeMultipartUpload: (_key, uploadId) => ({
        uploadPart: vi.fn(),
        complete: vi.fn(),
        abort: async () => {
          aborted.push(uploadId);
        },
      }),
    }));

    await expect(reconcileStorageMultipartCleanups(now)).resolves.toEqual({
      inspected: 2,
      settled: 2,
      errors: 0,
    });
    expect(aborted.sort()).toEqual(["multipart-a", "multipart-b"]);
  });

  it("gates object deletion until every handle settles, then adds a grace", async () => {
    const now = new Date("2026-08-27T03:00:00.000Z");
    const objectKey = "storage/user/account-deletion";
    addObjectCleanup(objectKey, now);
    await Promise.all([
      enqueueStorageMultipartCleanup({
        objectKey,
        uploadId: "multipart-a",
        notBefore: now,
      }),
      enqueueStorageMultipartCleanup({
        objectKey,
        uploadId: "multipart-b",
        notBefore: now,
      }),
    ]);

    await expect(claimAiStorageCleanupForDeletion({
      objectKey,
      state: "cleanup",
      notBefore: now,
      now,
    })).resolves.toMatchObject({ claimed: false });
    expect(memory.state.aiStorageCleanups.get(objectKey)?.leaseToken).toBeNull();

    setR2BucketProvider(() => ({
      resumeMultipartUpload: () => ({
        uploadPart: vi.fn(),
        complete: vi.fn(),
        abort: async () => undefined,
      }),
    }));
    const settlementStartedAt = Date.now();
    await expect(reconcileStorageMultipartCleanups(now)).resolves.toEqual({
      inspected: 2,
      settled: 2,
      errors: 0,
    });

    expect(memory.state.storageMultipartCleanups.size).toBe(0);
    expect(memory.state.aiStorageCleanups.get(objectKey)!.notBefore.getTime())
      .toBeGreaterThanOrEqual(
        settlementStartedAt + STORAGE_MULTIPART_SETTLEMENT_GRACE_MILLISECONDS,
      );
  });

  it("starts the full grace at remote settlement, not delayed scheduledAt", async () => {
    const settlementStartedAt = Date.now();
    const scheduledAt = new Date(settlementStartedAt - 60 * 60 * 1000);
    const objectKey = "storage/user/delayed-schedule";
    addObjectCleanup(objectKey, scheduledAt);
    await enqueueStorageMultipartCleanup({
      objectKey,
      uploadId: "multipart-delayed",
      notBefore: scheduledAt,
    });
    setR2BucketProvider(() => ({
      resumeMultipartUpload: () => ({
        uploadPart: vi.fn(),
        complete: vi.fn(),
        abort: async () => undefined,
      }),
    }));

    await expect(reconcileStorageMultipartCleanups(scheduledAt))
      .resolves.toEqual({ inspected: 1, settled: 1, errors: 0 });
    expect(memory.state.aiStorageCleanups.get(objectKey)!.notBefore.getTime())
      .toBeGreaterThanOrEqual(
        settlementStartedAt +
          STORAGE_MULTIPART_SETTLEMENT_GRACE_MILLISECONDS,
      );
  });

  it("deletes an object that appears after an in-flight complete returns NoSuchUpload", async () => {
    const now = new Date("2026-08-27T04:00:00.000Z");
    const objectKey = "storage/user/in-flight-complete";
    addObjectCleanup(objectKey, now);
    await enqueueStorageMultipartCleanup({
      objectKey,
      uploadId: "multipart-completing",
      notBefore: now,
    });
    let objectVisible = false;
    const deleted: string[] = [];
    setR2BucketProvider(() => ({
      delete: async (key: string) => {
        if (objectVisible) {
          deleted.push(key);
          objectVisible = false;
        }
      },
      resumeMultipartUpload: () => ({
        uploadPart: vi.fn(),
        complete: vi.fn(),
        abort: async () => {
          throw Object.assign(new Error("NoSuchUpload"), {
            code: "NoSuchUpload",
          });
        },
      }),
    }));

    const [objectResult, multipartResult] = await Promise.all([
      reconcileAiStorageCleanups(now),
      reconcileStorageMultipartCleanups(now),
    ]);
    expect(objectResult).toEqual({ inspected: 1, deleted: 0, errors: 0 });
    expect(multipartResult).toEqual({ inspected: 1, settled: 1, errors: 0 });
    objectVisible = true;
    const graceUntil = memory.state.aiStorageCleanups.get(objectKey)!.notBefore;
    expect(graceUntil.getTime()).toBeGreaterThanOrEqual(
      now.getTime() + STORAGE_MULTIPART_SETTLEMENT_GRACE_MILLISECONDS,
    );
    await expect(
      reconcileAiStorageCleanups(new Date(graceUntil.getTime() - 1)),
    ).resolves.toEqual({ inspected: 0, deleted: 0, errors: 0 });
    await expect(reconcileAiStorageCleanups(graceUntil)).resolves.toEqual({
      inspected: 1,
      deleted: 1,
      errors: 0,
    });
    expect(deleted).toEqual([objectKey]);
    expect(objectVisible).toBe(false);
  });

  it("defers a multipart-blocked object so later due rows are not starved", async () => {
    const now = new Date("2026-08-27T05:00:00.000Z");
    const blockedKey = "storage/user/blocked-first";
    addObjectCleanup(blockedKey, now);
    for (let index = 0; index < 100; index++) {
      addObjectCleanup(`storage/user/free-${index.toString().padStart(3, "0")}`, now);
    }
    await enqueueStorageMultipartCleanup({
      objectKey: blockedKey,
      uploadId: "multipart-blocker",
      notBefore: now,
    });
    const deleted: string[] = [];
    setR2BucketProvider(() => ({
      delete: async (key: string) => {
        deleted.push(key);
      },
    }));

    await expect(reconcileAiStorageCleanups(now)).resolves.toEqual({
      inspected: 100,
      deleted: 99,
      errors: 0,
    });
    await expect(reconcileAiStorageCleanups(now)).resolves.toEqual({
      inspected: 1,
      deleted: 1,
      errors: 0,
    });
    expect(deleted).toHaveLength(100);
    expect(memory.state.aiStorageCleanups.has(blockedKey)).toBe(true);
    expect(memory.state.aiStorageCleanups.get(blockedKey)!.notBefore.getTime())
      .toBeGreaterThan(now.getTime());
  });

  it("moves an old multipart intervention beyond each sweep so it cannot occupy the due page forever", async () => {
    const old = new Date("2026-08-26T00:00:00.000Z");
    const now = new Date("2026-08-27T12:00:00.000Z");
    const objectKey = "storage/user/old-intervention";
    addObjectCleanup(objectKey, old);
    await enqueueStorageMultipartCleanup({
      objectKey,
      uploadId: "multipart-old-intervention",
      notBefore: old,
    });
    const multipart = memory.state.storageMultipartCleanups.get(
      `${objectKey}\0multipart-old-intervention`,
    )!;
    multipart.status = "intervention";
    multipart.interventionAt = old;

    await expect(reconcileAiStorageCleanups(now)).resolves.toMatchObject({
      inspected: 1,
      deleted: 0,
      errors: 0,
    });

    expect(memory.state.aiStorageCleanups.get(objectKey)!.notBefore.getTime())
      .toBeGreaterThanOrEqual(
        now.getTime() + STORAGE_MULTIPART_SETTLEMENT_GRACE_MILLISECONDS,
      );
  });

  it("persists bounded failures and supports exact CAS resume and terminalize", async () => {
    const now = new Date("2026-08-27T06:00:00.000Z");
    const objectKey = "storage/user/intervention";
    const uploadId = "multipart-intervention";
    await enqueueStorageMultipartCleanup({ objectKey, uploadId, notBefore: now });
    let claim = await (await import("@beutl/db")).claimStorageMultipartCleanup({ expected: { objectKey, uploadId, leaseToken: null, notBefore: now }, now });
    for (let i = 0; i < STORAGE_MULTIPART_MAX_ATTEMPTS; i++) {
      await recordStorageMultipartCleanupFailure({ objectKey, uploadId, leaseToken: claim!.leaseToken, now: new Date(now.getTime() + i * 3_600_000), error: `failure-${i}` });
      if (i < STORAGE_MULTIPART_MAX_ATTEMPTS - 1) {
        const row = memory.state.storageMultipartCleanups.get(`${objectKey}\0${uploadId}`)!;
        claim = await (await import("@beutl/db")).claimStorageMultipartCleanup({ expected: { objectKey, uploadId, leaseToken: null, notBefore: row.notBefore }, now: row.notBefore });
      }
    }
    const [row] = await listStorageMultipartInterventions();
    expect(row).toMatchObject({ status: "intervention", attempts: STORAGE_MULTIPART_MAX_ATTEMPTS, lastError: "failure-4" });
    const resumed = await resumeStorageMultipartIntervention({ objectKey, uploadId, expectedRevision: row.revision, expectedInterventionAt: row.interventionAt!, now });
    expect(resumed.status).toBe("resumed");
    await enqueueStorageMultipartCleanup({ objectKey, uploadId: `${uploadId}-terminal`, notBefore: now });
    const second = await (await import("@beutl/db")).claimStorageMultipartCleanup({ expected: { objectKey, uploadId: `${uploadId}-terminal`, leaseToken: null, notBefore: now }, now });
    await recordStorageMultipartCleanupFailure({ objectKey, uploadId: `${uploadId}-terminal`, leaseToken: second!.leaseToken, now, error: "persistent" , maxAttempts: 1 });
    const [row2] = await listStorageMultipartInterventions();
    const terminal = await terminalizeStorageMultipartIntervention({ objectKey, uploadId: `${uploadId}-terminal`, expectedRevision: row2.revision, expectedInterventionAt: row2.interventionAt!, now, operatorUserId: "admin", operatorReason: "Confirmed multipart is unrecoverable", operatorEvidence: "Ticket SEC-123 confirms remote state" });
    expect(terminal.status).toBe("terminalized");
    const terminalRow = memory.state.storageMultipartCleanups.get(`${objectKey}\0${uploadId}-terminal`)!;
    expect(terminalRow).toMatchObject({ status: "terminal", operatorUserId: "admin", operatorReason: "Confirmed multipart is unrecoverable", operatorEvidence: "Ticket SEC-123 confirms remote state", terminalizedAt: now });
    await expect(terminalizeStorageMultipartIntervention({ objectKey, uploadId: `${uploadId}-terminal`, expectedRevision: terminalRow.revision, expectedInterventionAt: row2.interventionAt!, now, operatorUserId: "admin", operatorReason: "", operatorEvidence: "" })).resolves.toMatchObject({ status: "unsafe" });
  });

  it("releases object cleanup after terminalization while active handles still gate it", async () => {
    const now = new Date("2026-08-27T07:00:00.000Z");
    const objectKey = "storage/user/terminal-grace";
    addObjectCleanup(objectKey, now);
    await enqueueStorageMultipartCleanup({ objectKey, uploadId: "multipart-terminal", notBefore: now });
    const claim = await (await import("@beutl/db")).claimStorageMultipartCleanup({ expected: { objectKey, uploadId: "multipart-terminal", leaseToken: null, notBefore: now }, now });
    await recordStorageMultipartCleanupFailure({ objectKey, uploadId: "multipart-terminal", leaseToken: claim!.leaseToken, now, error: "persistent", maxAttempts: 1 });
    const intervention = memory.state.storageMultipartCleanups.get(`${objectKey}\0multipart-terminal`)!;
    await expect(claimAiStorageCleanupForDeletion({ objectKey, state: "cleanup", notBefore: now, now })).resolves.toMatchObject({ claimed: false });
    const terminal = await terminalizeStorageMultipartIntervention({ objectKey, uploadId: "multipart-terminal", expectedRevision: intervention.revision, expectedInterventionAt: intervention.interventionAt!, now, operatorUserId: "admin", operatorReason: "Remote handle verified unrecoverable", operatorEvidence: "Incident INC-123 and provider response" });
    expect(terminal.status).toBe("terminalized");
    const grace = memory.state.aiStorageCleanups.get(objectKey)!.notBefore;
    expect(grace.getTime()).toBeGreaterThanOrEqual(now.getTime() + STORAGE_MULTIPART_SETTLEMENT_GRACE_MILLISECONDS);
    await expect(claimAiStorageCleanupForDeletion({ objectKey, state: "cleanup", notBefore: grace, now: grace })).resolves.toMatchObject({ claimed: true, shouldDeleteObject: true });
  });

  it.each(["pending", "processing", "retry", "intervention"] as const)(
    "keeps %s multipart rows as deletion gates",
    async (status) => {
      const now = new Date("2026-08-27T08:00:00.000Z");
      const objectKey = `storage/user/status-${status}`;
      addObjectCleanup(objectKey, now);
      await enqueueStorageMultipartCleanup({ objectKey, uploadId: "multipart-status", notBefore: now });
      const row = memory.state.storageMultipartCleanups.get(`${objectKey}\0multipart-status`)!;
      row.status = status;
      await expect(claimAiStorageCleanupForDeletion({ objectKey, state: "cleanup", notBefore: now, now })).resolves.toMatchObject({ claimed: false, shouldDeleteObject: false });
      expect(memory.state.aiStorageCleanups.get(objectKey)?.leaseToken).toBeNull();
    },
  );
});
