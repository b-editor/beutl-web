import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  claimPendingStorageFileReference,
  deleteUserById,
  enqueueFileCleanupIfUnreferenced,
  finalizeStorageUpload,
  replaceReleaseArtifact,
  reserveStorageUpload,
  StorageCleanupConflictError,
} from "@beutl/db";

const file = {
  id: "new-file",
  objectKey: "new-object",
  name: "extension.nupkg",
  size: 10,
  mimeType: "application/octet-stream",
  userId: "user-id",
  visibility: "DEDICATED" as const,
  sha256: "package-sha256",
};

describe("storage cleanup outbox database contract", () => {
  it("reserves cleanup before a File exists", async () => {
    const create = vi.fn(async ({ data }: { data: unknown }) => data);
    await reserveStorageUpload({
      id: "cleanup-id",
      fileId: file.id,
      objectKey: file.objectKey,
      prisma: { storageCleanup: { create } } as never,
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: "cleanup-id",
        fileId: file.id,
        objectKey: file.objectKey,
        reason: "PENDING_UPLOAD",
        availableAt: expect.any(Date),
      }),
    });
  });

  it("creates a dedicated File while retaining an unleased reference reservation", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const createFile = vi.fn(async ({ data }: { data: unknown }) => data);
    const deleteMany = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      storageCleanup: { updateMany, deleteMany },
      file: { create: createFile },
    } as never;

    await finalizeStorageUpload({
      cleanupId: "cleanup-id",
      file,
      pendingReference: true,
      prisma,
    });

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ leaseId: null }),
        data: { reason: "PENDING_REFERENCE" },
      }),
    );
    expect(createFile).toHaveBeenCalledWith({ data: file });
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("refuses to attach a File after its cleanup lease was claimed", async () => {
    const deleteMany = vi.fn(async () => ({ count: 0 }));
    await expect(
      claimPendingStorageFileReference({
        fileId: file.id,
        prisma: { storageCleanup: { deleteMany } } as never,
      }),
    ).rejects.toBeInstanceOf(StorageCleanupConflictError);
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        fileId: file.id,
        reason: "PENDING_REFERENCE",
        leaseId: null,
      },
    });
  });

  it("does not queue a shared legacy File while another release references it", async () => {
    const upsert = vi.fn();
    const findUnique = vi.fn(async () => ({
      objectKey: "shared-object",
      _count: {
        Package: 0,
        PackageScreenshot: 0,
        Profile: 0,
        Release: 1,
      },
    }));

    await expect(
      enqueueFileCleanupIfUnreferenced({
        fileId: "shared-file",
        prisma: {
          file: { findUnique },
          storageCleanup: { upsert },
        } as never,
      }),
    ).resolves.toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("swaps one shared release without clearing the other release attestation", async () => {
    const releases = new Map([
      ["first", {
        fileId: "shared-file",
        packageSha256: "shared-package-sha",
        approvedAnalyticsManifestSha256: "shared-manifest-sha",
      }],
      ["second", {
        fileId: "shared-file",
        packageSha256: "shared-package-sha",
        approvedAnalyticsManifestSha256: "shared-manifest-sha",
      }],
    ]);
    const updateMany = vi.fn(async ({ where, data }) => {
      const current = releases.get(where.id);
      if (!current || current.fileId !== where.fileId) return { count: 0 };
      releases.set(where.id, { ...current, ...data });
      return { count: 1 };
    });
    const cleanupUpsert = vi.fn();
    const prisma = {
      release: {
        updateMany,
        findUniqueOrThrow: vi.fn(async ({ where }) => releases.get(where.id)),
      },
      storageCleanup: {
        deleteMany: vi.fn(async () => ({ count: 1 })),
        upsert: cleanupUpsert,
      },
      file: {
        findUnique: vi.fn(async () => ({
          objectKey: "shared-object",
          _count: {
            Package: 0,
            PackageScreenshot: 0,
            Profile: 0,
            Release: 1,
          },
        })),
      },
    } as never;

    await replaceReleaseArtifact({
      id: "first",
      expectedFileId: "shared-file",
      metadata: {
        title: "Release",
        description: "",
        targetVersion: "1.0.0",
        published: false,
      },
      artifact: {
        fileId: "new-file",
        packageSha256: "new-package-sha",
        approvedAnalyticsManifestSha256: null,
      },
      prisma,
    });

    expect(releases.get("second")).toEqual({
      fileId: "shared-file",
      packageSha256: "shared-package-sha",
      approvedAnalyticsManifestSha256: "shared-manifest-sha",
    });
    expect(cleanupUpsert).not.toHaveBeenCalled();
  });

  it("migrates a durable, non-FK cleanup outbox", async () => {
    const migration = await readFile(
      new URL(
        "../../apps/web/prisma/migrations/20260811000000_add_release_analytics_manifest/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(migration).toContain('CREATE TABLE "StorageCleanup"');
    expect(migration).toContain('"objectKey" STRING NOT NULL');
    expect(migration).toContain('"attempts" INT4 NOT NULL DEFAULT 0');
    const cleanupTable = migration.split('CREATE TABLE "StorageCleanup"')[1]
      .split(");")[0];
    expect(cleanupTable).not.toContain("FOREIGN KEY");
  });

  it("queues every owned object before a cascading account deletion", async () => {
    const order: string[] = [];
    const upsert = vi.fn(async () => {
      order.push("cleanup");
    });
    const deleteUser = vi.fn(async () => {
      order.push("user");
    });
    await deleteUserById({
      userId: "user-id",
      prisma: {
        file: {
          findMany: vi.fn(async () => [
            { id: "file-id", objectKey: "object-key" },
          ]),
        },
        storageCleanup: { upsert },
        user: { delete: deleteUser },
      } as never,
    });

    expect(order).toEqual(["cleanup", "user"]);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          fileId: "file-id",
          objectKey: "object-key",
          reason: "USER_DELETION",
        }),
      }),
    );
  });
});
