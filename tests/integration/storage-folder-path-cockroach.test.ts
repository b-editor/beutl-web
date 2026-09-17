import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import {
  setDbProvider,
  storageFolderPath,
  storageFolderSummary,
  updateOwnedStorageFolder,
} from "@beutl/db";

const connectionString = process.env.TEST_DATABASE_URL;
const describeWithCockroach = connectionString ? describe : describe.skip;

describeWithCockroach(
  "Storage folder traversal on CockroachDB (set TEST_DATABASE_URL to run)",
  () => {
    let prisma: PrismaClient;
    let admin: PrismaClient;
    const database = `codex_storage_path_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    beforeAll(async () => {
      const url = new URL(connectionString!);
      url.pathname = "/defaultdb";
      admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
      await admin.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
      url.pathname = `/${database}`;
      prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
      await prisma.$executeRawUnsafe(`
      CREATE TABLE "StorageFolder" (
        "id" STRING PRIMARY KEY,
        "name" STRING NOT NULL,
        "userId" STRING NOT NULL,
        "parentId" STRING REFERENCES "StorageFolder" ("id") ON DELETE CASCADE,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT current_timestamp(),
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT current_timestamp()
      )
    `);
      await prisma.$executeRawUnsafe(`
        CREATE TABLE "File" (
          "id" STRING PRIMARY KEY,
          "userId" STRING NOT NULL,
          "folderId" STRING REFERENCES "StorageFolder" ("id") ON DELETE SET NULL
        )
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TABLE "AiJob" (
          "id" STRING PRIMARY KEY,
          "resultFileId" STRING UNIQUE REFERENCES "File" ("id") ON DELETE SET NULL
        )
      `);
      setDbProvider(async () => prisma);
    });
    beforeEach(async () => {
      await prisma.$executeRaw`DELETE FROM "AiJob"`;
      await prisma.$executeRaw`DELETE FROM "File"`;
      await prisma.storageFolder.deleteMany({});
    });
    afterEach(() => vi.restoreAllMocks());
    afterAll(async () => {
      await prisma?.$disconnect();
      if (admin) {
        await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${database}" CASCADE`);
        await admin.$disconnect();
      }
    });

    it("loads 256 ancestors with one parameterized query and preserves metadata and order", async () => {
      const ids = Array.from({ length: 256 }, (_, index) => `folder-${index}`);
      await prisma.storageFolder.createMany({
        data: ids.map((id, index) => ({
          id,
          name: `Name ${id}`,
          userId: "owner",
          parentId: ids[index - 1] ?? null,
        })),
      });
      const query = vi.spyOn(prisma, "$queryRaw");
      const single = vi.spyOn(prisma.storageFolder, "findFirst");

      const path = await storageFolderPath("owner", ids.at(-1)!);

      expect(path?.map((folder) => folder.id)).toEqual(ids);
      expect(path?.[0]).toMatchObject({
        name: "Name folder-0",
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      });
      expect(path?.[0]).not.toHaveProperty("userId");
      expect(query).toHaveBeenCalledTimes(1);
      expect(single).not.toHaveBeenCalled();
    });

    it("summarizes 256 descendant levels with two queries", async () => {
      const ids = Array.from({ length: 256 }, (_, index) => `folder-${index}`);
      await prisma.storageFolder.createMany({
        data: ids.map((id, index) => ({
          id,
          name: id,
          userId: "owner",
          parentId: ids[index - 1] ?? null,
        })),
      });
      await prisma.$executeRaw`INSERT INTO "File" ("id", "userId", "folderId") VALUES
        ('root-file', 'owner', 'folder-0'), ('leaf-file', 'owner', 'folder-255')`;
      const query = vi.spyOn(prisma, "$queryRaw");
      const children = vi.spyOn(prisma.storageFolder, "findMany");
      expect(await storageFolderSummary("owner", ids[0])).toMatchObject({
        folder: { id: ids[0] },
        ancestors: [],
        folderCount: 255,
        fileCount: 2,
      });
      expect(query).toHaveBeenCalledTimes(2);
      expect(children).not.toHaveBeenCalled();
    });

    it("excludes foreign descendants, foreign files and AI outputs from summaries", async () => {
      await prisma.storageFolder.createMany({
        data: [
          { id: "root", name: "Root", userId: "owner" },
          { id: "child", name: "Child", userId: "owner", parentId: "root" },
          { id: "foreign", name: "Foreign", userId: "other", parentId: "root" },
          { id: "hidden", name: "Hidden", userId: "owner", parentId: "foreign" },
        ],
      });
      await prisma.$executeRaw`INSERT INTO "File" ("id", "userId", "folderId") VALUES
        ('owned', 'owner', 'child'), ('foreign-file', 'other', 'child'),
        ('ai-result', 'owner', 'child'), ('hidden-file', 'owner', 'hidden')`;
      await prisma.$executeRaw`INSERT INTO "AiJob" ("id", "resultFileId") VALUES ('job', 'ai-result')`;
      expect(await storageFolderSummary("owner", "root")).toMatchObject({
        folderCount: 1,
        fileCount: 1,
      });
      expect(await storageFolderSummary("owner", "child")).toMatchObject({
        folderCount: 0,
        fileCount: 1,
        ancestors: [{ id: "root" }],
      });
      await expect(storageFolderSummary("owner", "missing")).resolves.toBeNull();
      await expect(storageFolderSummary("owner", "foreign")).resolves.toBeNull();
    });

    it("keeps quoted identifiers as values and rejects foreign ancestors", async () => {
      const owner = "owner's account";
      const id = "root' OR 1=1 --";
      await prisma.storageFolder.createMany({
        data: [
          { id, name: "Root", userId: owner },
          { id: "foreign", name: "Foreign", userId: "other" },
          { id: "child", name: "Child", userId: owner, parentId: "foreign" },
        ],
      });

      expect((await storageFolderPath(owner, id))?.map((folder) => folder.id)).toEqual([id]);
      await expect(storageFolderPath(owner, "missing")).resolves.toBeNull();
      await expect(storageFolderPath(owner, "foreign")).resolves.toBeNull();
      await expect(storageFolderPath(owner, "child")).resolves.toBeNull();
      await expect(storageFolderPath(owner, null)).resolves.toEqual([]);
    });

    it("uses the recursive lookup inside serializable moves and terminates corrupt cycles", async () => {
      await prisma.storageFolder.createMany({
        data: [
          { id: "parent", name: "Parent", userId: "owner" },
          { id: "child", name: "Child", userId: "owner", parentId: "parent" },
        ],
      });
      await expect(
        updateOwnedStorageFolder("owner", "parent", { parentId: "child" }),
      ).resolves.toEqual({ kind: "intoItself" });
      expect(
        (await prisma.storageFolder.findUnique({ where: { id: "parent" } }))?.parentId,
      ).toBeNull();

      await prisma.storageFolder.update({ where: { id: "parent" }, data: { parentId: "child" } });
      await expect(storageFolderPath("owner", "child")).rejects.toThrow(
        "Cyclic storage folder hierarchy",
      );
    });
  },
);
