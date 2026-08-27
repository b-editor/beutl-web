import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimStorageUploadCompletion,
  claimStorageUploadForAbandon,
  countStorageUploadsByUserId,
  freezeStorageUploadForAccountDeletion,
  listStorageUploadInterventions,
  recordStorageUploadCompletionFailure,
  resumeStorageUploadIntervention,
  setDbProvider,
  terminalizeStorageUploadIntervention,
  enqueueUserStorageCleanups,
  StorageCleanupBusyError,
} from "@beutl/db";
import { abandonStaleStorageUploads } from "@beutl/api";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const NOW = new Date("2026-08-28T00:00:00.000Z");
const USER = "completion-state-user";

function addIntervention(memory: ReturnType<typeof createInMemoryPrisma>, overrides: Record<string, unknown> = {}) {
  const row = {
    id: "upload-state-1",
    userId: USER,
    objectKey: "storage/completion-state-1",
    uploadId: "multipart-state-1",
    name: "clip.bin",
    mimeType: "application/octet-stream",
    size: BigInt(10),
    partSize: 5,
    createdAt: NOW,
    completedFileId: null,
    abandonedAt: null,
    startState: "active",
    creationLeaseUntil: null,
    creationLeaseToken: null,
    completionState: "intervention",
    completionLeaseUntil: null,
    completionLeaseToken: null,
    completionAttempts: 2,
    completionLastError: "provider outcome is unknown",
    completionInterventionAt: new Date(NOW.getTime() - 1_000),
    completionRevision: 4,
    cleanupLeaseUntil: null,
    cleanupLeaseToken: null,
    ...overrides,
  } as never;
  memory.state.storageUploads.set(row.id, row);
  return row;
}

describe("storage upload completion state machine", () => {
  let memory: ReturnType<typeof createInMemoryPrisma>;

  beforeEach(() => {
    vi.restoreAllMocks();
    memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
  });

  it("keeps attempts one and two retryable and fences stale cleanup, then lists attempt three for intervention", async () => {
    const row = addIntervention(memory, {
      completionState: "completing",
      completionLeaseToken: "lease-1",
      completionLeaseUntil: new Date(NOW.getTime() + 60_000),
      completionAttempts: 0,
      completionRevision: 0,
      completionInterventionAt: null,
    });

    for (let attempt = 1; attempt <= 3; attempt++) {
      const current = memory.state.storageUploads.get(row.id)!;
      memory.state.storageUploads.set(row.id, {
        ...current,
        completionState: "completing",
        completionLeaseToken: `lease-${attempt}`,
        completionLeaseUntil: new Date(NOW.getTime() + 60_000),
      });
      const leaseToken = `lease-${attempt}`;
      const result = await recordStorageUploadCompletionFailure({
        id: row.id,
        userId: USER,
        leaseToken,
        expected: memory.state.storageUploads.get(row.id)! as never,
        error: `failure-${attempt}`,
        now: new Date(NOW.getTime() + attempt * 1_000),
      });
      expect(result.status).toBe(attempt === 3 ? "intervention" : "retry");
      if (attempt < 3) {
        const current = memory.state.storageUploads.get(row.id)!;
        expect(current.completionState).toBe("retry");
        expect(await claimStorageUploadForAbandon({
          id: row.id,
          userId: USER,
          now: NOW,
          cleanupLeaseToken: `cleanup-${attempt}`,
          cleanupLeaseUntil: new Date(NOW.getTime() + 60_000),
          expected: current as never,
        })).toBe(false);
        expect(await freezeStorageUploadForAccountDeletion({
          id: row.id,
          userId: USER,
          now: NOW,
          expected: { ...current, abandonedAt: null } as never,
        })).toBe(false);
      }
    }

    expect(memory.state.storageUploads.get(row.id)?.completionAttempts).toBe(3);
    await expect(listStorageUploadInterventions()).resolves.toHaveLength(1);
  });

  it("keeps an operator resume fenced until the next completion claim", async () => {
    const row = addIntervention(memory);
    const resumed = await resumeStorageUploadIntervention({
      id: row.id,
      userId: USER,
      objectKey: row.objectKey,
      uploadId: row.uploadId,
      expectedRevision: row.completionRevision,
      expectedInterventionAt: row.completionInterventionAt,
      operatorUserId: "operator-1",
      operatorReason: "Approved a fresh provider attempt",
      operatorEvidence: "Incident INC-100 reviewed",
      now: NOW,
    });
    expect(resumed).toEqual({ status: "resumed", revision: 5 });
    const retry = memory.state.storageUploads.get(row.id)!;
    expect(retry.completionState).toBe("resumed");
    expect(retry.completionRetryNotBefore).toEqual(
      new Date(NOW.getTime() + 15 * 60_000),
    );
    await expect(enqueueUserStorageCleanups({ userId: USER, now: NOW }))
      .rejects.toBeInstanceOf(StorageCleanupBusyError);
    expect(memory.state.storageUploads.get(row.id)?.abandonedAt).toBeNull();
    expect(await claimStorageUploadCompletion({
      id: row.id,
      userId: USER,
      now: NOW,
      leaseUntil: new Date(NOW.getTime() + 60_000),
      leaseToken: "next-finish",
      expected: retry as never,
    })).toBe(true);
    expect(memory.state.storageUploads.get(row.id)).toMatchObject({
      completionState: "completing",
      completionRetryNotBefore: null,
    });

    const wrong = await resumeStorageUploadIntervention({
      id: row.id,
      userId: USER,
      objectKey: "wrong-key",
      uploadId: row.uploadId,
      expectedRevision: 5,
      expectedInterventionAt: row.completionInterventionAt,
      operatorUserId: "operator-1",
      operatorReason: "Approved a fresh provider attempt",
      operatorEvidence: "Incident INC-100 reviewed",
      now: NOW,
    });
    expect(wrong.status).toBe("conflict");
  });

  it("escalates a due retry on the scheduler without remote cleanup", async () => {
    const row = addIntervention(memory, {
      createdAt: new Date(NOW.getTime() - 2 * 24 * 60 * 60_000),
      completionState: "completing",
      completionLeaseToken: "lease-1",
      completionLeaseUntil: new Date(NOW.getTime() + 60_000),
      completionAttempts: 0,
      completionRevision: 0,
      completionInterventionAt: null,
    });
    await recordStorageUploadCompletionFailure({ id: row.id, userId: USER, leaseToken: "lease-1", expected: memory.state.storageUploads.get(row.id)! as never, error: "ambiguous", now: NOW });
    await expect(abandonStaleStorageUploads(new Date(NOW.getTime() + 14 * 60_000))).resolves.toMatchObject({ abandoned: 0 });
    expect(memory.state.storageUploads.get(row.id)?.completionState).toBe("retry");
    await expect(abandonStaleStorageUploads(new Date(NOW.getTime() + 16 * 60_000))).resolves.toMatchObject({ abandoned: 0 });
    expect(memory.state.storageUploads.get(row.id)?.completionState).toBe("intervention");
    await expect(enqueueUserStorageCleanups({ userId: USER, now: NOW })).rejects.toBeInstanceOf(StorageCleanupBusyError);
    expect(await freezeStorageUploadForAccountDeletion({ id: row.id, userId: USER, now: NOW, expected: { ...memory.state.storageUploads.get(row.id)!, abandonedAt: null } as never })).toBe(false);
  });

  it("escalates an expired completion lease without touching R2", async () => {
    const row = addIntervention(memory, { completionState: "completing", completionLeaseToken: "crashed", completionLeaseUntil: new Date(NOW.getTime() - 1), completionAttempts: 0, completionRevision: 0, completionInterventionAt: null });
    await expect(abandonStaleStorageUploads(NOW)).resolves.toMatchObject({ abandoned: 0 });
    expect(memory.state.storageUploads.get(row.id)).toMatchObject({ completionState: "intervention", completionLeaseToken: null, completionLeaseUntil: null });
    expect(memory.state.storageUploads.get(row.id)?.completionAttempts).toBe(1);
  });

  it("returns an unused operator resume to intervention without exposing cleanup", async () => {
    const row = addIntervention(memory);
    await expect(resumeStorageUploadIntervention({
      id: row.id,
      userId: USER,
      objectKey: row.objectKey,
      uploadId: row.uploadId,
      expectedRevision: row.completionRevision,
      expectedInterventionAt: row.completionInterventionAt,
      operatorUserId: "operator-1",
      operatorReason: "Approved a fresh provider attempt",
      operatorEvidence: "Incident INC-100 reviewed",
      now: NOW,
    })).resolves.toMatchObject({ status: "resumed" });

    const due = new Date(NOW.getTime() + 16 * 60_000);
    await expect(abandonStaleStorageUploads(due)).resolves.toMatchObject({ abandoned: 0 });
    expect(memory.state.storageUploads.get(row.id)).toMatchObject({
      completionState: "intervention",
      completionLastError: "Operator resume expired before a provider attempt",
      abandonedAt: null,
    });
  });

  it("rejects account-deletion freeze when completionRevision changes after the snapshot", async () => {
    const row = addIntervention(memory, {
      completionState: "idle",
      completionLeaseToken: null,
      completionLeaseUntil: null,
      completionAttempts: 0,
      completionInterventionAt: null,
      completionRevision: 7,
    });
    const originalFindMany = memory.prisma.storageUpload.findMany.bind(
      memory.prisma.storageUpload,
    );
    let snapshotted = false;
    vi.spyOn(memory.prisma.storageUpload, "findMany").mockImplementation(
      async (args) => {
        const snapshot = await originalFindMany(args as never);
        if (!snapshotted && snapshot.some((item) => item.id === row.id)) {
          snapshotted = true;
          const current = memory.state.storageUploads.get(row.id)!;
          memory.state.storageUploads.set(row.id, {
            ...current,
            completionRevision: current.completionRevision + 1,
          });
        }
        return snapshot;
      },
    );

    await expect(enqueueUserStorageCleanups({ userId: USER, now: NOW }))
      .rejects.toBeInstanceOf(StorageCleanupBusyError);
    expect(memory.state.storageUploads.get(row.id)?.abandonedAt).toBeNull();
    expect(memory.state.storageUploads.get(row.id)?.completionRevision).toBe(8);
  });

  it("terminalization extends early outboxes and removes the quota-tracking row", async () => {
    const row = addIntervention(memory);
    const early = new Date(NOW.getTime() + 1_000);
    memory.state.storageMultipartCleanups.set(`${row.objectKey}\0${row.uploadId}`, {
      objectKey: row.objectKey,
      uploadId: row.uploadId,
      leaseToken: null,
      notBefore: early,
      attempts: 1,
      lastError: null,
      interventionAt: null,
      status: "pending",
      revision: 2,
      createdAt: NOW,
      updatedAt: NOW,
    });
    memory.state.aiStorageCleanups.set(row.objectKey, {
      objectKey: row.objectKey,
      aiJobId: null,
      leaseToken: null,
      state: "cleanup",
      notBefore: early,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await expect(terminalizeStorageUploadIntervention({
      id: row.id,
      userId: USER,
      objectKey: row.objectKey,
      uploadId: row.uploadId,
      expectedRevision: row.completionRevision,
      expectedInterventionAt: row.completionInterventionAt,
      now: NOW,
      operatorUserId: "operator-1",
      operatorReason: "Confirmed provider state is unrecoverable",
      operatorEvidence: "Incident INC-100 and provider audit evidence",
    })).resolves.toMatchObject({ status: "terminalized" });
    expect(memory.state.storageUploads.has(row.id)).toBe(false);
    expect(await countStorageUploadsByUserId({ userId: USER })).toBe(0);
    expect(memory.state.storageMultipartCleanups.get(`${row.objectKey}\0${row.uploadId}`)?.notBefore.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 15 * 60_000);
    expect(memory.state.aiStorageCleanups.get(row.objectKey)?.notBefore.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 15 * 60_000);
    await expect(enqueueUserStorageCleanups({ userId: USER, now: NOW })).resolves.toBeDefined();
  });

  it("rolls back outboxes when a cleanup lease is active or the final CAS loses", async () => {
    const row = addIntervention(memory);
    const leaseUntil = new Date(NOW.getTime() + 60_000);
    memory.state.storageMultipartCleanups.set(`${row.objectKey}\0${row.uploadId}`, {
      objectKey: row.objectKey, uploadId: row.uploadId, leaseToken: "worker", notBefore: leaseUntil,
      attempts: 0, lastError: null, interventionAt: null, status: "processing", revision: 0,
      createdAt: NOW, updatedAt: NOW,
    });
    await expect(terminalizeStorageUploadIntervention({
      id: row.id, userId: USER, objectKey: row.objectKey, uploadId: row.uploadId,
      expectedRevision: row.completionRevision, expectedInterventionAt: row.completionInterventionAt,
      now: NOW, operatorUserId: "operator-1", operatorReason: "Confirmed provider state", operatorEvidence: "Incident INC-100 evidence",
    })).rejects.toThrow("Multipart cleanup is currently leased");
    expect(memory.state.storageUploads.has(row.id)).toBe(true);
    expect(memory.state.aiStorageCleanups.size).toBe(0);

    memory.state.storageMultipartCleanups.delete(`${row.objectKey}\0${row.uploadId}`);
    memory.state.aiStorageCleanups.set(row.objectKey, {
      objectKey: row.objectKey, aiJobId: null, leaseToken: "object-worker", state: "processing", notBefore: leaseUntil,
      createdAt: NOW, updatedAt: NOW,
    });
    await expect(terminalizeStorageUploadIntervention({
      id: row.id, userId: USER, objectKey: row.objectKey, uploadId: row.uploadId,
      expectedRevision: row.completionRevision, expectedInterventionAt: row.completionInterventionAt,
      now: NOW, operatorUserId: "operator-1", operatorReason: "Confirmed provider state", operatorEvidence: "Incident INC-100 evidence",
    })).rejects.toThrow("Object cleanup is currently leased");
    expect(memory.state.storageUploads.has(row.id)).toBe(true);
    expect(memory.state.storageMultipartCleanups.size).toBe(0);
    expect(memory.state.aiStorageCleanups.get(row.objectKey)?.leaseToken).toBe("object-worker");
    memory.state.aiStorageCleanups.delete(row.objectKey);
    const deleteMany = vi.spyOn(memory.prisma.storageUpload, "deleteMany").mockResolvedValue({ count: 0 });
    await expect(terminalizeStorageUploadIntervention({
      id: row.id, userId: USER, objectKey: row.objectKey, uploadId: row.uploadId,
      expectedRevision: row.completionRevision, expectedInterventionAt: row.completionInterventionAt,
      now: NOW, operatorUserId: "operator-1", operatorReason: "Confirmed provider state", operatorEvidence: "Incident INC-100 evidence",
    })).rejects.toThrow("changed during terminalization");
    expect(deleteMany).toHaveBeenCalled();
    expect(memory.state.storageUploads.has(row.id)).toBe(true);
    expect(memory.state.storageMultipartCleanups.size).toBe(0);
    expect(memory.state.aiStorageCleanups.size).toBe(0);
  });

  it("does not resurrect terminal or intervention multipart outboxes", async () => {
    const row = addIntervention(memory);
    const key = `${row.objectKey}\0${row.uploadId}`;
    memory.state.storageMultipartCleanups.set(key, { objectKey: row.objectKey, uploadId: row.uploadId, leaseToken: null, notBefore: NOW, attempts: 1, lastError: "done", interventionAt: null, status: "terminal", revision: 3, createdAt: NOW, updatedAt: NOW });
    await expect(terminalizeStorageUploadIntervention({ id: row.id, userId: USER, objectKey: row.objectKey, uploadId: row.uploadId, expectedRevision: row.completionRevision, expectedInterventionAt: row.completionInterventionAt, now: NOW, operatorUserId: "operator-1", operatorReason: "Confirmed provider state", operatorEvidence: "Incident INC-100 evidence" })).resolves.toMatchObject({ status: "terminalized" });
    expect(memory.state.storageMultipartCleanups.get(key)?.status).toBe("terminal");

    const second = addIntervention(memory, { id: "upload-state-2", objectKey: "storage/completion-state-2", uploadId: "multipart-state-2" });
    const secondKey = `${second.objectKey}\0${second.uploadId}`;
    memory.state.storageMultipartCleanups.set(secondKey, { objectKey: second.objectKey, uploadId: second.uploadId, leaseToken: null, notBefore: NOW, attempts: 1, lastError: "operator", interventionAt: NOW, status: "intervention", revision: 3, createdAt: NOW, updatedAt: NOW });
    await expect(terminalizeStorageUploadIntervention({ id: second.id, userId: USER, objectKey: second.objectKey, uploadId: second.uploadId, expectedRevision: second.completionRevision, expectedInterventionAt: second.completionInterventionAt, now: NOW, operatorUserId: "operator-1", operatorReason: "Confirmed provider state", operatorEvidence: "Incident INC-100 evidence" })).rejects.toThrow("Multipart cleanup requires operator intervention");
    expect(memory.state.storageUploads.has(second.id)).toBe(true);
  });

  it("rolls back when a raced multipart create returns an active row", async () => {
    const row = addIntervention(memory);
    const createMany = vi.spyOn(memory.prisma.storageMultipartCleanup, "createMany").mockImplementationOnce(async () => {
      memory.state.storageMultipartCleanups.set(`${row.objectKey}\0${row.uploadId}`, {
        objectKey: row.objectKey, uploadId: row.uploadId, leaseToken: "worker", notBefore: new Date(NOW.getTime() + 60 * 60_000), attempts: 0, lastError: null, interventionAt: null, status: "processing", revision: 4, createdAt: NOW, updatedAt: NOW,
      });
      return { count: 0 };
    });
    await expect(terminalizeStorageUploadIntervention({ id: row.id, userId: USER, objectKey: row.objectKey, uploadId: row.uploadId, expectedRevision: row.completionRevision, expectedInterventionAt: row.completionInterventionAt, now: NOW, operatorUserId: "operator-1", operatorReason: "Confirmed provider state", operatorEvidence: "Incident INC-100 evidence" })).rejects.toThrow("Multipart cleanup changed");
    expect(createMany).toHaveBeenCalled();
    expect(memory.state.storageUploads.has(row.id)).toBe(true);
    expect(memory.state.storageMultipartCleanups.size).toBe(0);
  });
});
