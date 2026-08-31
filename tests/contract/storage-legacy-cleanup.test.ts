import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

vi.mock("server-only", () => ({}));
const getContext = vi.hoisted(() => vi.fn());

let createStorageFile: typeof import("../../apps/web/src/lib/storage").createStorageFile;
let createDedicatedStorageFile: typeof import("../../apps/web/src/lib/storage").createDedicatedStorageFile;
let deleteStorageFile: typeof import("../../apps/web/src/lib/storage").deleteStorageFile;

beforeAll(async () => {
  const requireFromWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));
  vi.doMock(requireFromWeb.resolve("@opennextjs/cloudflare"), () => ({ getCloudflareContext: getContext }));
  ({ createStorageFile, createDedicatedStorageFile, deleteStorageFile } = await import("../../apps/web/src/lib/storage"));
});

import {
  claimAiStorageCleanupForDeletion,
  createDedicatedStorageReservation,
  DEDICATED_STORAGE_LATE_PUT_GRACE_MILLISECONDS,
  deleteAiStorageCleanup,
  deleteFileWithStorageCleanup,
  deleteUserFilesWithStorageCleanup,
  findStorageCleanupForMutation,
  freezeStorageUploadForAccountDeletion,
  deleteReleaseWithStorageCleanup,
  deleteDevPackageScreenshotAndFile,
  deleteUnreferencedFileWithStorageCleanup,
  setDbProvider,
} from "@beutl/db";
import { reconcileAiStorageCleanups, setR2BucketProvider } from "@beutl/api";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

describe("legacy storage cleanup contracts", () => {
  let memory: ReturnType<typeof createInMemoryPrisma>;
  let bucket: { put: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn>; head: ReturnType<typeof vi.fn> };
  let background: Promise<unknown>[];

  beforeEach(() => {
    vi.restoreAllMocks();
    memory = createInMemoryPrisma();
    background = [];
    bucket = {
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      head: vi.fn(async (key: string) => memory.state.files.size ? { size: 1 } : null),
    };
    setDbProvider(async () => memory.prisma as never);
    setR2BucketProvider(() => bucket as never);
    getContext.mockReturnValue({
      env: { BEUTL_R2_BUCKET: bucket },
      ctx: { waitUntil: (promise: Promise<unknown>) => background.push(promise) },
    });
  });

  afterEach(() => vi.useRealTimers());

  it("persists a writing outbox before put and settles File plus outbox atomically", async () => {
    const source = await readFile(
      new URL("../../apps/web/src/lib/storage.ts", import.meta.url),
      "utf8",
    );
    const helper = source.slice(
      source.indexOf("export async function createStorageFile"),
      source.indexOf("export async function createDedicatedStorageFile"),
    );
    expect(helper).not.toContain("prisma");
    const order: string[] = [];
    bucket.put.mockImplementation(async () => { order.push("put"); });
    const originalCreate = memory.prisma.aiStorageCleanup.create;
    memory.prisma.aiStorageCleanup.create = async (args: never) => { order.push("outbox"); return originalCreate(args); };
    const file = new File([new Uint8Array([1, 2])], "clip.bin", { type: "application/octet-stream" });
    const record = await createStorageFile({ file, userId: "u", visibility: "PRIVATE" });
    expect(order.slice(0, 2)).toEqual(["outbox", "put"]);
    expect(memory.state.files.has(record.id)).toBe(true);
    expect(memory.state.aiStorageCleanups.has(record.objectKey)).toBe(false);
  });

  it("leaves the writing outbox when File insertion fails", async () => {
    memory.prisma.file.create = vi.fn(async () => { throw new Error("db unavailable"); }) as never;
    const file = new File([new Uint8Array([1])], "broken.bin", { type: "application/octet-stream" });
    await expect(createStorageFile({ file, userId: "u", visibility: "PRIVATE" })).rejects.toThrow("db unavailable");
    expect(memory.state.aiStorageCleanups.size).toBe(1);
    expect([...memory.state.aiStorageCleanups.values()][0].state).toBe("cleanup");
  });

  it("does not put an object when the durable write outbox cannot be registered", async () => {
    memory.prisma.aiStorageCleanup.create = vi.fn(async () => {
      throw new Error("outbox unavailable");
    }) as never;
    const file = new File([new Uint8Array([1])], "untracked.bin", {
      type: "application/octet-stream",
    });

    await expect(createStorageFile({
      file,
      userId: "u",
      visibility: "PRIVATE",
    })).rejects.toThrow("outbox unavailable");
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it("reserves quota before reading or putting a dedicated artifact", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "over.bin", {
      type: "application/octet-stream",
    });
    const read = vi.spyOn(file, "arrayBuffer");
    memory.state.files.set("existing", {
      id: "existing", userId: "u", objectKey: "objects/existing", name: "existing.bin",
      size: 1, mimeType: "application/octet-stream", visibility: "DEDICATED",
      sha256: null, createdAt: new Date(), updatedAt: new Date(),
    });

    await expect(createDedicatedStorageFile({
      file,
      userId: "u",
      quotaBytes: BigInt(1),
      fileCountLimit: 10,
    })).resolves.toMatchObject({ kind: "overQuota" });
    expect(read).not.toHaveBeenCalled();
    expect(bucket.put).not.toHaveBeenCalled();
    expect(memory.state.storageUploads.size).toBe(0);
  });

  it("commits a dedicated File by consuming the durable reservation", async () => {
    const order: string[] = [];
    const originalReservation = memory.prisma.storageUpload.create;
    memory.prisma.storageUpload.create = vi.fn(async (args: never) => {
      order.push("reservation");
      return originalReservation(args);
    }) as never;
    bucket.put.mockImplementation(async () => { order.push("put"); });
    const file = new File([new Uint8Array([1, 2])], "artifact.bin", {
      type: "application/octet-stream",
    });

    const result = await createDedicatedStorageFile({
      file,
      userId: "u",
      quotaBytes: BigInt(10),
      fileCountLimit: 10,
    });
    expect(result.kind).toBe("created");
    expect(order).toEqual(["reservation", "put"]);
    expect(memory.state.files.size).toBe(1);
    expect([...memory.state.storageUploads.values()][0]).toMatchObject({
      reservationKind: "dedicated",
      completedFileId: result.record.id,
      creationLeaseUntil: null,
      creationLeaseToken: null,
    });
    expect(memory.state.aiStorageCleanups.size).toBe(0);
  });

  it("recovers a lost dedicated File-commit response without a duplicate put", async () => {
    const originalTransaction = memory.prisma.$transaction;
    let transactionCount = 0;
    memory.prisma.$transaction = vi.fn(async (callback: never) => {
      const result = await originalTransaction(callback);
      transactionCount++;
      if (transactionCount === 2) throw new Error("commit response lost");
      return result;
    }) as never;
    const file = new File([new Uint8Array([1, 2])], "response-loss.bin", {
      type: "application/octet-stream",
    });
    const result = await createDedicatedStorageFile({
      file,
      userId: "u",
      quotaBytes: BigInt(10),
      fileCountLimit: 10,
    });
    expect(result.kind).toBe("created");
    expect(bucket.put).toHaveBeenCalledTimes(1);
    expect(memory.state.files.size).toBe(1);
    expect(memory.state.storageUploads.size).toBe(1);
    expect([...memory.state.storageUploads.values()][0].completedFileId).toBe(result.record.id);
    memory.prisma.$transaction = originalTransaction;
  });

  it("replays publication after a lost commit response without duplicating the File or relation", async () => {
    const source = await readFile(new URL("../../packages/db/src/package.ts", import.meta.url), "utf8");
    const create = source.slice(
      source.indexOf("export async function createDevPackageScreenshot"),
      source.indexOf("export async function reorderDevPackageScreenshots"),
    );
    expect(create).toContain("upsert");
    expect(create).toContain("packageId_fileId");
    const originalTransaction = memory.prisma.$transaction;
    let transactionCount = 0;
    const relationIds = new Set<string>();
    let publishCalls = 0;
    memory.prisma.$transaction = vi.fn(async (callback: never) => {
      const result = await originalTransaction(callback);
      transactionCount++;
      if (transactionCount === 2) throw new Error("commit response lost");
      return result;
    }) as never;
    const result = await createDedicatedStorageFile({
      file: new File([new Uint8Array([7])], "relation.bin"),
      userId: "u",
      quotaBytes: BigInt(10),
      fileCountLimit: 10,
      publish: async (_tx, record) => {
        publishCalls++;
        relationIds.add(record.id);
      },
    });
    expect(result.kind).toBe("created");
    expect(memory.state.files.size).toBe(1);
    expect(publishCalls).toBe(2);
    expect(relationIds.size).toBe(1);
    expect(bucket.put).toHaveBeenCalledTimes(1);
    memory.prisma.$transaction = originalTransaction;
  });

  it("publishes a dedicated relation inside the File commit and cleans up on publication failure", async () => {
    const published: string[] = [];
    const result = await createDedicatedStorageFile({
      file: new File([new Uint8Array([1, 2])], "publish.bin"),
      userId: "u",
      quotaBytes: BigInt(10),
      fileCountLimit: 10,
      publish: async (_tx, record) => {
        published.push(record.id);
      },
    });
    expect(result.kind).toBe("created");
    expect(published).toEqual([result.record.id]);

    await expect(createDedicatedStorageFile({
      file: new File([new Uint8Array([3])], "rollback.bin"),
      userId: "u",
      quotaBytes: BigInt(20),
      fileCountLimit: 10,
      publish: async () => { throw new Error("relation transaction failed"); },
    })).rejects.toThrow("relation transaction failed");
    expect([...memory.state.files.values()].some((file) => file.name === "rollback.bin")).toBe(false);
    expect([...memory.state.aiStorageCleanups.values()].some((row) => row.objectKey)).toBe(true);
  });

  it("keeps icon replacement and screenshot deletion pointer-first and durable", async () => {
    const source = await readFile(new URL("../../packages/db/src/package.ts", import.meta.url), "utf8");
    const icon = source.slice(source.indexOf("export async function replaceDevPackageIconFile"), source.indexOf("export async function retrieveDevPackageDependsFile"));
    expect(icon.indexOf("tx.package.update")).toBeLessThan(icon.indexOf("deleteUnreferencedFileWithStorageCleanup"));
    expect(icon).toContain("deleteUnreferencedFileWithStorageCleanup");
    const screenshot = source.slice(source.indexOf("export async function deleteDevPackageScreenshotAndFile"), source.indexOf("export async function deleteDevPackage({"));
    expect(screenshot).toContain("packageScreenshot.deleteMany");
    expect(screenshot).toContain("deleteUnreferencedFileWithStorageCleanup");
    expect(screenshot.indexOf("packageScreenshot.deleteMany")).toBeLessThan(screenshot.indexOf("deleteUnreferencedFileWithStorageCleanup"));
  });

  it("rejects mismatched screenshot relation before touching the File", async () => {
    const calls: string[] = [];
    const tx = {
      packageScreenshot: {
        findUnique: async () => null,
        deleteMany: async () => { calls.push("relation-delete"); return { count: 1 }; },
      },
      file: {
        findFirst: async () => { calls.push("file-read"); return null; },
        deleteMany: async () => { calls.push("file-delete"); return { count: 1 }; },
      },
      aiStorageCleanup: {
        create: async () => { calls.push("outbox"); },
        updateMany: async () => ({ count: 1 }),
      },
    } as never;
    await expect(deleteDevPackageScreenshotAndFile({ packageId: "pkg", fileId: "file", prisma: tx })).rejects.toThrow("not found");
    expect(calls).toEqual([]);

    const crossUser = {
      ...tx,
      packageScreenshot: {
        findUnique: async () => ({ package: { userId: "package-owner" }, file: { userId: "other-owner" } }),
        deleteMany: async () => { calls.push("relation-delete"); return { count: 1 }; },
      },
    } as never;
    await expect(deleteDevPackageScreenshotAndFile({ packageId: "pkg", fileId: "file", prisma: crossUser })).rejects.toThrow("not found");
    expect(calls).toEqual([]);
  });

  it("deletes a valid screenshot relation and owned File exactly once with an outbox", async () => {
    const calls: string[] = [];
    const tx = {
      packageScreenshot: {
        findUnique: async () => ({ package: { userId: "u" }, file: { userId: "u" } }),
        deleteMany: async () => { calls.push("relation-delete"); return { count: 1 }; },
      },
      file: {
        findFirst: async () => ({ id: "file", objectKey: "obj", userId: "u", aiJobResult: null }),
        deleteMany: async () => { calls.push("file-delete"); return { count: 1 }; },
      },
      aiStorageCleanup: {
        create: async () => { calls.push("outbox-create"); },
        updateMany: async () => { calls.push("outbox-promote"); return { count: 1 }; },
      },
    } as never;
    await deleteDevPackageScreenshotAndFile({ packageId: "pkg", fileId: "file", prisma: tx });
    expect(calls).toEqual(["relation-delete", "outbox-create", "file-delete", "outbox-promote"]);
  });

  it("keeps a shared File when another package relation still references it", async () => {
    const calls: string[] = [];
    let findCount = 0;
    const tx = {
      file: {
        findFirst: async () => {
          findCount++;
          if (findCount === 1) return { id: "file", objectKey: "obj", userId: "u", aiJobResult: null };
          return {
            Package: [{ id: "other-package" }],
            PackageScreenshot: [],
            Profile: [],
            Release: [],
            aiJobResult: null,
            storageUploadReceipt: null,
          };
        },
        deleteMany: async () => { calls.push("file-delete"); return { count: 1 }; },
      },
      aiStorageCleanup: {
        create: async () => { calls.push("outbox-create"); },
        updateMany: async () => { calls.push("outbox-promote"); return { count: 1 }; },
      },
    } as never;
    await deleteUnreferencedFileWithStorageCleanup({
      fileId: "file",
      userId: "u",
      prisma: tx,
    });
    expect(calls).toEqual([]);
  });

  it("generic storage deletion refuses a legacy visible package artifact", async () => {
    const calls: string[] = [];
    let reads = 0;
    const tx = {
      file: {
        findFirst: async () => {
          reads++;
          if (reads === 1) {
            return {
              id: "file",
              userId: "u",
              objectKey: "objects/legacy",
              visibility: "PUBLIC",
              aiJobResult: null,
            };
          }
          return {
            Package: [{ id: "package" }],
            PackageScreenshot: [],
            Profile: [],
            Release: [],
            aiJobResult: null,
          };
        },
        deleteMany: async () => {
          calls.push("file-delete");
          return { count: 1 };
        },
      },
      aiStorageCleanup: {
        create: async () => {
          calls.push("outbox-create");
        },
        updateMany: async () => ({ count: 1 }),
      },
    } as never;

    await expect(
      deleteFileWithStorageCleanup({ fileId: "file", userId: "u", prisma: tx }),
    ).rejects.toThrow("still in use");
    expect(calls).toEqual([]);
  });

  it("retains an entire user selection when any file is referenced", async () => {
    const calls: string[] = [];
    const tx = {
      file: {
        findMany: async () => [
          {
            id: "ordinary",
            visibility: "PRIVATE",
            Package: [],
            PackageScreenshot: [],
            Profile: [],
            Release: [],
            aiJobResult: null,
          },
          {
            id: "shared",
            visibility: "PUBLIC",
            Package: [],
            PackageScreenshot: [],
            Profile: [],
            Release: [{ id: "release" }],
            aiJobResult: null,
          },
        ],
        findFirst: async () => {
          calls.push("file-read");
          return null;
        },
        deleteMany: async () => {
          calls.push("file-delete");
          return { count: 1 };
        },
      },
    } as never;

    await expect(
      deleteUserFilesWithStorageCleanup({
        fileIds: ["ordinary", "shared"],
        userId: "u",
        prisma: tx,
      }),
    ).resolves.toMatchObject({ kind: "inUse" });
    expect(calls).toEqual([]);
  });

  it("publishes release replacements inside the dedicated File commit", async () => {
    const action = await readFile(
      new URL(
        "../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/actions/release.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const update = action.slice(
      action.indexOf("export async function updateRelease"),
      action.indexOf("export async function createRelease"),
    );
    expect(update).toContain("published = await publishRelease(tx, record.id)");
    expect(update).not.toContain("uploadedFileId");
    expect(update).not.toContain("deleteStorageFile");
  });

  it("deletes a release pointer before retiring its unreferenced File", async () => {
    const calls: string[] = [];
    let fileRead = 0;
    const tx = {
      release: {
        findUnique: async () => ({
          package: { userId: "u" },
          file: { id: "file", userId: "u" },
        }),
        delete: async () => {
          calls.push("release-delete");
          return { id: "release" };
        },
      },
      file: {
        findFirst: async () => {
          fileRead++;
          if (fileRead === 1) {
            return { id: "file", objectKey: "obj", userId: "u", aiJobResult: null };
          }
          return {
            Package: [],
            PackageScreenshot: [],
            Profile: [],
            Release: [],
            aiJobResult: null,
          };
        },
        deleteMany: async () => {
          calls.push("file-delete");
          return { count: 1 };
        },
      },
      aiStorageCleanup: {
        create: async () => {
          calls.push("outbox-create");
        },
        updateMany: async () => {
          calls.push("outbox-promote");
          return { count: 1 };
        },
      },
    } as never;

    await deleteReleaseWithStorageCleanup({
      id: "release",
      userId: "u",
      prisma: tx,
    });
    expect(calls).toEqual([
      "release-delete",
      "outbox-create",
      "file-delete",
      "outbox-promote",
    ]);
  });

  it("keeps a release artifact while another reference remains", async () => {
    const calls: string[] = [];
    let fileRead = 0;
    const tx = {
      release: {
        findUnique: async () => ({
          package: { userId: "u" },
          file: { id: "file", userId: "u" },
        }),
        delete: async () => {
          calls.push("release-delete");
          return { id: "release" };
        },
      },
      file: {
        findFirst: async () => {
          fileRead++;
          if (fileRead === 1) {
            return { id: "file", objectKey: "obj", userId: "u", aiJobResult: null };
          }
          return {
            Package: [{ id: "other-package" }],
            PackageScreenshot: [],
            Profile: [],
            Release: [],
            aiJobResult: null,
          };
        },
        deleteMany: async () => {
          calls.push("file-delete");
          return { count: 1 };
        },
      },
      aiStorageCleanup: {
        create: async () => {
          calls.push("outbox-create");
        },
        updateMany: async () => {
          calls.push("outbox-promote");
          return { count: 1 };
        },
      },
    } as never;

    await deleteReleaseWithStorageCleanup({
      id: "release",
      userId: "u",
      prisma: tx,
    });
    expect(calls).toEqual(["release-delete"]);
  });

  it("uses reference-aware cleanup for package and release deletion actions", async () => {
    const packageDb = await readFile(
      new URL("../../packages/db/src/package.ts", import.meta.url),
      "utf8",
    );
    const packageDelete = packageDb.slice(
      packageDb.indexOf("export async function deleteDevPackage({"),
      packageDb.indexOf("export async function upsertPackagePricings"),
    );
    expect(packageDelete.indexOf("tx.package.delete")).toBeLessThan(
      packageDelete.indexOf("deleteUnreferencedFileWithStorageCleanup"),
    );

    const packageAction = await readFile(
      new URL(
        "../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/actions/package.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const releaseAction = await readFile(
      new URL(
        "../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/actions/release.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(packageAction).not.toContain("deleteStorageFile");
    expect(releaseAction).not.toContain("deleteStorageFile");
    expect(releaseAction).toContain("deleteReleaseWithStorageCleanup");
  });

  it("enforces a unique screenshot order per package", async () => {
    const schema = await readFile(new URL("../../apps/web/prisma/schema.prisma", import.meta.url), "utf8");
    const migration = await readFile(new URL("../../apps/web/prisma/migrations/20260831010000_unique_package_screenshot_order/migration.sql", import.meta.url), "utf8");
    const action = await readFile(new URL("../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/actions/screenshot.ts", import.meta.url), "utf8");
    const packageDb = await readFile(new URL("../../packages/db/src/package.ts", import.meta.url), "utf8");
    const reorder = packageDb.slice(
      packageDb.indexOf("export async function reorderDevPackageScreenshots"),
      packageDb.indexOf("export async function updateDevPackageTags"),
    );
    expect(schema).toContain("@@unique([packageId, order])");
    expect(migration).toContain('"PackageScreenshot_packageId_order_key"');
    expect(migration).toContain("ROW_NUMBER() OVER");
    expect(action.indexOf("tx.package.update")).toBeLessThan(
      action.lastIndexOf("retrieveDevPackageLastScreenshotOrder"),
    );
    expect(reorder.indexOf("tx.package.update")).toBeLessThan(
      reorder.indexOf("packageScreenshot.findMany"),
    );
    expect(reorder).toContain("order: -(index + 1)");
  });

  it("defers object cleanup while a dedicated reservation is still active", async () => {
    const { releaseDedicatedStorageReservation } = await import("@beutl/db");
    const reservation = await createDedicatedStorageReservation({
      userId: "u",
      id: "dedicated-reservation",
      objectKey: "objects/slow",
      name: "slow.bin",
      mimeType: "application/octet-stream",
      size: BigInt(2),
      quotaBytes: BigInt(10),
      fileCountLimit: 10,
    });
    expect(reservation.kind).toBe("reserved");
    const future = new Date(Date.now() + 16 * 60_000);
    await expect(reconcileAiStorageCleanups(future)).resolves.toMatchObject({ deleted: 0, errors: 0 });
    expect(bucket.delete).not.toHaveBeenCalled();

    await releaseDedicatedStorageReservation({
      id: "dedicated-reservation",
      userId: "u",
      objectKey: "objects/slow",
      now: new Date(),
    });
    await expect(reconcileAiStorageCleanups(new Date(Date.now() + 16 * 60_000))).resolves.toMatchObject({ deleted: 1, errors: 0 });
    expect(bucket.delete).toHaveBeenCalledWith("objects/slow");
  });

  it("blocks account deletion while a dedicated put owns its durable lease", async () => {
    let resolvePut!: () => void;
    bucket.put.mockImplementation(() => new Promise<void>((resolve) => {
      resolvePut = resolve;
    }));
    const operation = createDedicatedStorageFile({
      file: new File([new Uint8Array([1, 2])], "slow.bin"),
      userId: "u",
      quotaBytes: BigInt(10),
      fileCountLimit: 10,
    });
    await vi.waitFor(() => expect(bucket.put).toHaveBeenCalledTimes(1));
    const row = [...memory.state.storageUploads.values()][0];
    await expect(freezeStorageUploadForAccountDeletion({
      id: row.id,
      userId: row.userId,
      now: new Date(),
      expected: { ...row, abandonedAt: null } as never,
    })).resolves.toBe(false);
    expect(memory.state.storageUploads.get(row.id)?.abandonedAt).toBeNull();

    resolvePut();
    await expect(operation).resolves.toMatchObject({ kind: "created" });
  });

  it("recreates cleanup when a put settles after deadline and User cascade", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T00:00:00.000Z"));
    let resolvePut!: () => void;
    bucket.put.mockImplementation(() => new Promise<void>((resolve) => {
      resolvePut = resolve;
    }));
    const operation = createDedicatedStorageFile({
      file: new File([new Uint8Array([1])], "late.bin"),
      userId: "u",
      quotaBytes: BigInt(10),
      fileCountLimit: 10,
    });
    const rejection = operation.then(
      () => null,
      (error: unknown) => error,
    );
    for (let tick = 0; tick < 20 && bucket.put.mock.calls.length === 0; tick++) {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(bucket.put).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30 * 1000);
    await expect(rejection).resolves.toMatchObject({
      message: expect.stringContaining("exceeded its local deadline"),
    });
    const unknown = [...memory.state.storageUploads.values()][0];
    expect(unknown.completionState).toBe("unknown");

    vi.setSystemTime(new Date(unknown.creationLeaseUntil!.getTime() + 1));
    await expect(freezeStorageUploadForAccountDeletion({
      id: unknown.id,
      userId: unknown.userId,
      now: new Date(),
      expected: { ...unknown, abandonedAt: null } as never,
    })).resolves.toBe(true);
    memory.state.storageUploads.delete(unknown.id);
    resolvePut();
    await Promise.all(background);
    expect(memory.state.aiStorageCleanups.get(unknown.objectKey)?.notBefore.getTime())
      .toBeLessThanOrEqual(Date.now());
    await expect(reconcileAiStorageCleanups(new Date())).resolves.toMatchObject({ deleted: 1 });
    expect(bucket.delete).toHaveBeenCalledWith(unknown.objectKey);
  });

  it("returns after the dedicated deadline even when recording unknown hangs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T00:00:00.000Z"));
    bucket.put.mockImplementation(() => new Promise<void>(() => undefined));
    const originalUpdateMany = memory.prisma.storageUpload.updateMany;
    memory.prisma.storageUpload.updateMany = vi.fn(async (args: {
      data?: { completionState?: string };
    }) => {
      if (args.data?.completionState === "unknown") {
        return await new Promise<never>(() => undefined);
      }
      return originalUpdateMany(args as never);
    }) as never;
    const operation = createDedicatedStorageFile({
      file: new File([new Uint8Array([1])], "db-hang.bin"),
      userId: "u",
      quotaBytes: BigInt(10),
      fileCountLimit: 10,
    });
    const rejection = operation.then(
      () => null,
      (error: unknown) => error,
    );
    for (let tick = 0; tick < 20 && bucket.put.mock.calls.length === 0; tick++) {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    }

    const backgroundBefore = background.length;
    await vi.advanceTimersByTimeAsync(30 * 1000);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2 * 1000);

    await expect(rejection).resolves.toMatchObject({
      message: expect.stringContaining("exceeded its local deadline"),
    });
    expect(background.length).toBeGreaterThan(backgroundBefore);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses a renewal that settles after the deadline as the unknown CAS lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T00:00:00.000Z"));
    bucket.put.mockImplementation(() => new Promise<void>(() => undefined));
    const originalUpdateMany = memory.prisma.storageUpload.updateMany;
    let renewalCalls = 0;
    let resolveRenewal!: (value: unknown) => void;
    memory.prisma.storageUpload.updateMany = vi.fn(async (args: any) => {
      if (args.data?.completionLeaseUntil && args.data?.creationLeaseUntil) {
        renewalCalls++;
        if (renewalCalls === 2) {
          return await new Promise((resolve) => {
            resolveRenewal = () => resolve(originalUpdateMany(args));
          });
        }
      }
      return originalUpdateMany(args);
    }) as never;
    const operation = createDedicatedStorageFile({
      file: new File([new Uint8Array([1])], "late-renewal.bin"),
      userId: "u", quotaBytes: BigInt(10), fileCountLimit: 10,
    });
    const rejection = operation.then(() => null, (error: unknown) => error);
    await vi.waitFor(() => expect(bucket.put).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(30_000);
    resolveRenewal();
    await vi.advanceTimersByTimeAsync(0);
    await expect(rejection).resolves.toMatchObject({
      message: expect.stringContaining("exceeded its local deadline"),
    });
    expect([...memory.state.storageUploads.values()][0].completionState).toBe("unknown");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("falls back to the stable lease token when renewal never resolves", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T00:00:00.000Z"));
    bucket.put.mockImplementation(() => new Promise<void>(() => undefined));
    const originalUpdateMany = memory.prisma.storageUpload.updateMany;
    let renewalCalls = 0;
    memory.prisma.storageUpload.updateMany = vi.fn(async (args: any) => {
      if (args.data?.completionLeaseUntil && args.data?.creationLeaseUntil) {
        renewalCalls++;
        if (renewalCalls === 2) return await new Promise<never>(() => undefined);
      }
      return originalUpdateMany(args);
    }) as never;
    const operation = createDedicatedStorageFile({
      file: new File([new Uint8Array([1])], "hung-renewal.bin"),
      userId: "u", quotaBytes: BigInt(10), fileCountLimit: 10,
    });
    const rejection = operation.then(() => null, (error: unknown) => error);
    await vi.waitFor(() => expect(bucket.put).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(rejection).resolves.toMatchObject({
      message: expect.stringContaining("exceeded its local deadline"),
    });
    expect([...memory.state.storageUploads.values()][0].completionState).toBe("unknown");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves cleanup grace across host loss and removes a late object", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T00:00:00.000Z"));
    const reserved = await createDedicatedStorageReservation({
      userId: "u",
      id: "host-loss",
      objectKey: "objects/host-loss",
      name: "host-loss.bin",
      mimeType: "application/octet-stream",
      size: BigInt(1),
      quotaBytes: BigInt(10),
      fileCountLimit: 10,
    });
    expect(reserved.kind).toBe("reserved");
    const active = memory.state.storageUploads.get("host-loss")!;
    await expect(freezeStorageUploadForAccountDeletion({
      id: active.id,
      userId: active.userId,
      now: new Date(),
      expected: { ...active, abandonedAt: null } as never,
    })).resolves.toBe(false);

    vi.setSystemTime(new Date(active.creationLeaseUntil!.getTime() + 1));
    const expired = memory.state.storageUploads.get("host-loss")!;
    await expect(freezeStorageUploadForAccountDeletion({
      id: expired.id,
      userId: expired.userId,
      now: new Date(),
      expected: { ...expired, abandonedAt: null } as never,
    })).resolves.toBe(true);
    const cleanup = memory.state.aiStorageCleanups.get("objects/host-loss")!;
    expect(cleanup.notBefore.getTime()).toBeGreaterThanOrEqual(
      Date.now() + DEDICATED_STORAGE_LATE_PUT_GRACE_MILLISECONDS,
    );
    // The User cascade removes the reservation, but the user-independent outbox
    // remains. A provider object that appears during the grace is still deleted.
    memory.state.storageUploads.delete("host-loss");
    await expect(reconcileAiStorageCleanups(new Date())).resolves.toMatchObject({ inspected: 0 });
    vi.setSystemTime(cleanup.notBefore);
    await expect(reconcileAiStorageCleanups(new Date())).resolves.toMatchObject({ deleted: 1 });
    expect(bucket.delete).toHaveBeenCalledWith("objects/host-loss");
  });

  it("terminalizes an expired dedicated unknown after the cleanup grace", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T00:00:00.000Z"));
    await createDedicatedStorageReservation({
      userId: "u",
      id: "unknown-expired",
      objectKey: "objects/unknown-expired",
      name: "unknown.bin",
      mimeType: "application/octet-stream",
      size: BigInt(1),
      quotaBytes: BigInt(10),
      fileCountLimit: 10,
    });
    const row = memory.state.storageUploads.get("unknown-expired")!;
    memory.state.storageUploads.set(row.id, {
      ...row,
      completionState: "unknown",
      completionInterventionAt: new Date(),
      completionLeaseUntil: null,
      completionLeaseToken: null,
    });
    const cleanup = memory.state.aiStorageCleanups.get(row.objectKey)!;
    vi.setSystemTime(new Date(cleanup.notBefore.getTime() + 1));
    await expect(reconcileAiStorageCleanups(new Date())).resolves.toMatchObject({ deleted: 0 });
    expect(memory.state.storageUploads.get(row.id)?.abandonedAt).not.toBeNull();
    await expect(reconcileAiStorageCleanups(new Date())).resolves.toMatchObject({ deleted: 1 });
    expect(memory.state.storageUploads.has(row.id)).toBe(false);
    expect(memory.state.aiStorageCleanups.has(row.objectKey)).toBe(false);
  });

  it("does not delete a live object after File commit response loss", async () => {
    const transaction = memory.prisma.$transaction;
    memory.prisma.$transaction = vi.fn(async (callback: never) => {
      await transaction(callback);
      throw new Error("commit response lost");
    }) as never;
    const file = new File([new Uint8Array([1])], "committed.bin", {
      type: "application/octet-stream",
    });

    await expect(createStorageFile({
      file,
      userId: "u",
      visibility: "PRIVATE",
    })).rejects.toThrow("commit response lost");
    expect(memory.state.files.size).toBe(1);
    expect(memory.state.aiStorageCleanups.size).toBe(1);

    memory.prisma.$transaction = transaction;
    await expect(reconcileAiStorageCleanups(new Date(Date.now() + 16 * 60_000)))
      .resolves.toMatchObject({ deleted: 0, errors: 0 });
    expect(bucket.delete).not.toHaveBeenCalled();
    expect(memory.state.aiStorageCleanups.size).toBe(0);
    expect(memory.state.files.size).toBe(1);
  });

  it("deletes File and cleanup row together, then acknowledges remote delete by CAS", async () => {
    const id = "file-1";
    memory.state.files.set(id, { id, userId: "u", objectKey: "objects/file-1", name: "x", size: 1, mimeType: "x", visibility: "PRIVATE", sha256: null, createdAt: new Date(), updatedAt: new Date() });
    const result = await deleteStorageFile({ fileId: id });
    expect(result.id).toBe(id);
    expect(memory.state.files.has(id)).toBe(false);
    expect(memory.state.aiStorageCleanups.has("objects/file-1")).toBe(false);
    expect(bucket.delete).toHaveBeenCalledWith("objects/file-1");
  });

  it("does not touch R2 from an ambient transaction that later rolls back", async () => {
    const id = "file-ambient";
    memory.state.files.set(id, { id, userId: "u", objectKey: "objects/ambient", name: "x", size: 1, mimeType: "x", visibility: "PRIVATE", sha256: null, createdAt: new Date(), updatedAt: new Date() });
    const transaction = memory.prisma.$transaction;
    await expect(memory.prisma.$transaction(async (tx: never) => {
      await deleteStorageFile({ fileId: id, prisma: tx });
      throw new Error("caller rollback");
    })).rejects.toThrow("caller rollback");
    expect(bucket.delete).not.toHaveBeenCalled();
    expect(memory.state.files.has(id)).toBe(true);
    memory.prisma.$transaction = transaction;
  });

  it("returns a committed logical deletion when remote delete fails and leaves outbox for scheduler", async () => {
    const id = "file-2";
    memory.state.files.set(id, { id, userId: "u", objectKey: "objects/file-2", name: "x", size: 1, mimeType: "x", visibility: "PRIVATE", sha256: null, createdAt: new Date(), updatedAt: new Date() });
    bucket.delete.mockRejectedValueOnce(new Error("R2 unavailable"));
    await expect(deleteStorageFile({ fileId: id })).resolves.toMatchObject({ id });
    expect(memory.state.files.has(id)).toBe(false);
    expect(memory.state.aiStorageCleanups.has("objects/file-2")).toBe(true);

    bucket.delete.mockResolvedValue(undefined);
    await expect(reconcileAiStorageCleanups(new Date())).resolves.toMatchObject({ deleted: 1, errors: 0 });
    expect(memory.state.aiStorageCleanups.has("objects/file-2")).toBe(false);
  });

  it("keeps delete cleanup durable when the database commit response is lost", async () => {
    const id = "file-delete-response-loss";
    memory.state.files.set(id, {
      id,
      userId: "u",
      objectKey: "objects/delete-response-loss",
      name: "x",
      size: 1,
      mimeType: "x",
      visibility: "PRIVATE",
      sha256: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const transaction = memory.prisma.$transaction;
    memory.prisma.$transaction = vi.fn(async (callback: never) => {
      await transaction(callback);
      throw new Error("delete commit response lost");
    }) as never;
    await expect(deleteStorageFile({ fileId: id, userId: "u" }))
      .rejects.toThrow("delete commit response lost");
    expect(memory.state.files.has(id)).toBe(false);
    expect(memory.state.aiStorageCleanups.has("objects/delete-response-loss")).toBe(true);
    expect(bucket.delete).not.toHaveBeenCalled();

    memory.prisma.$transaction = transaction;
    await expect(reconcileAiStorageCleanups(new Date())).resolves.toMatchObject({ deleted: 1 });
    expect(bucket.delete).toHaveBeenCalledWith("objects/delete-response-loss");
  });

  it("does not let a live File be deleted by a cleanup claim", async () => {
    const key = "objects/live";
    memory.state.files.set("live", { id: "live", userId: "u", objectKey: key, name: "x", size: 1, mimeType: "x", visibility: "PRIVATE", sha256: null, createdAt: new Date(), updatedAt: new Date() });
    await memory.prisma.aiStorageCleanup.create({ data: { objectKey: key, aiJobId: null, state: "cleanup", notBefore: new Date() } } as never);
    const row = await memory.prisma.aiStorageCleanup.findFirst({ where: { objectKey: key } });
    const claim = await claimAiStorageCleanupForDeletion({ objectKey: key, state: row!.state, notBefore: row!.notBefore, now: new Date(), leaseToken: row!.leaseToken });
    expect(claim).toMatchObject({ claimed: true, shouldDeleteObject: false });
    expect(memory.state.aiStorageCleanups.has(key)).toBe(false);
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it("does not mutate remote storage when cleanup registration or DB transaction fails", async () => {
    memory.prisma.$transaction = vi.fn(async () => { throw new Error("serialization failure"); }) as never;
    const id = "file-3";
    memory.state.files.set(id, { id, userId: "u", objectKey: "objects/file-3", name: "x", size: 1, mimeType: "x", visibility: "PRIVATE", sha256: null, createdAt: new Date(), updatedAt: new Date() });
    await expect(deleteStorageFile({ fileId: id })).rejects.toThrow("serialization failure");
    expect(bucket.delete).not.toHaveBeenCalled();
    expect(memory.state.files.has(id)).toBe(true);
  });

  it("keeps an acknowledged cleanup CAS-safe when a stale acknowledgement races a new writer", async () => {
    const key = "objects/cas";
    await memory.prisma.aiStorageCleanup.create({ data: { objectKey: key, aiJobId: null, state: "cleanup", notBefore: new Date() } } as never);
    const snapshot = await memory.prisma.aiStorageCleanup.findFirst({ where: { objectKey: key } });
    await memory.prisma.aiStorageCleanup.updateMany({ where: { objectKey: key, leaseToken: null }, data: { leaseToken: "new-owner" } } as never);
    await expect(deleteAiStorageCleanup({ objectKey: key })).rejects.toThrow();
    expect(memory.state.aiStorageCleanups.get(key)?.leaseToken).toBe("new-owner");
    expect(snapshot).toBeTruthy();
  });
});
