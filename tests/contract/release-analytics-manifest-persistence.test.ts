import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  findReleaseByPackageAndVersion,
  ReleaseArtifactConflictError,
  replaceReleaseArtifact,
  updateReleaseMetadata,
} from "@beutl/db";

function releasePrisma() {
  const update = vi.fn(async ({ data }: { data: unknown }) => data);
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const findFirst = vi.fn(async () => null);
  const findUniqueOrThrow = vi.fn(async () => ({ id: "release-id" }));
  const deleteMany = vi.fn(async () => ({ count: 1 }));
  return {
    update,
    updateMany,
    findFirst,
    findUniqueOrThrow,
    prisma: {
      release: { update, updateMany, findFirst, findUniqueOrThrow },
      storageCleanup: { deleteMany },
    },
  };
}

const metadata = {
  title: "Release",
  description: "Description",
  targetVersion: "1.0.0",
  published: false,
};

describe("release analytics manifest persistence", () => {
  it("CAS-replaces the file and clears every old attestation value together", async () => {
    const { prisma, updateMany } = releasePrisma();

    await replaceReleaseArtifact({
      id: "a5d1b348-b14b-4e1b-b9e8-41da17c834a5",
      expectedFileId: null,
      metadata,
      artifact: {
        fileId: "replacement-file",
        packageSha256: "replacement-package-sha256",
        approvedAnalyticsManifestSha256: null,
      },
      prisma: prisma as never,
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "a5d1b348-b14b-4e1b-b9e8-41da17c834a5",
        fileId: null,
      },
      data: {
        ...metadata,
        fileId: "replacement-file",
        packageSha256: "replacement-package-sha256",
        approvedAnalyticsManifestSha256: null,
      },
    });
  });

  it("rejects a concurrent swap before claiming the losing upload", async () => {
    const { prisma, updateMany } = releasePrisma();
    updateMany.mockResolvedValue({ count: 0 });

    await expect(
      replaceReleaseArtifact({
        id: "release-id",
        expectedFileId: "stale-file",
        metadata,
        artifact: {
          fileId: "loser-file",
          packageSha256: "loser-package-sha256",
          approvedAnalyticsManifestSha256: null,
        },
        prisma: prisma as never,
      }),
    ).rejects.toBeInstanceOf(ReleaseArtifactConflictError);
    expect(prisma.storageCleanup.deleteMany).not.toHaveBeenCalled();
  });

  it("persists the file, package digest, and approved digest together", async () => {
    const { prisma, updateMany } = releasePrisma();

    await replaceReleaseArtifact({
      id: "release-id",
      expectedFileId: null,
      metadata,
      artifact: {
        fileId: "replacement-file",
        packageSha256:
          "68c263d42a10a827fd6ed1eca1a2cdd4652b38dd86e613a545fe4668d7215eea",
        approvedAnalyticsManifestSha256:
          "71402716b5a89c6e125c4a163e76e4e8f36fa8d6528bdf28f3226031337f3101",
      },
      prisma: prisma as never,
    });

    expect(updateMany.mock.calls[0][0].data).toMatchObject({
      fileId: "replacement-file",
      packageSha256:
        "68c263d42a10a827fd6ed1eca1a2cdd4652b38dd86e613a545fe4668d7215eea",
      approvedAnalyticsManifestSha256:
        "71402716b5a89c6e125c4a163e76e4e8f36fa8d6528bdf28f3226031337f3101",
    });
  });

  it("keeps generic metadata updates separate from artifact fields", async () => {
    const { prisma, update } = releasePrisma();

    await updateReleaseMetadata({
      id: "release-id",
      ...metadata,
      prisma: prisma as never,
    });

    const data = update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).toEqual(metadata);
    expect(data).not.toHaveProperty("fileId");
    expect(data).not.toHaveProperty("packageSha256");
    expect(data).not.toHaveProperty("approvedAnalyticsManifestSha256");
  });

  it("selects file identity and both digests in one release query", async () => {
    const { prisma, findFirst } = releasePrisma();

    await findReleaseByPackageAndVersion({
      packageId: "package-id",
      version: "1.0.0",
      prisma: prisma as never,
    });

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          fileId: true,
          packageSha256: true,
          approvedAnalyticsManifestSha256: true,
          file: { select: { id: true, sha256: true } },
        }),
      }),
    );
  });

  it("enforces approval integrity and restrictive artifact deletion", async () => {
    const migration = await readFile(
      new URL(
        "../../apps/web/prisma/migrations/20260811000000_add_release_analytics_manifest/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(migration).toContain(
      'CONSTRAINT "Release_approved_manifest_requires_file_check"',
    );
    expect(migration).toMatch(
      /"approvedAnalyticsManifestSha256" IS NULL[\s\S]*"fileId" IS NOT NULL[\s\S]*"packageSha256" IS NOT NULL/,
    );
    expect(migration).toMatch(
      /FOREIGN KEY \("fileId"\) REFERENCES "File"\("id"\)[\s\S]*ON DELETE RESTRICT/,
    );
  });
});
