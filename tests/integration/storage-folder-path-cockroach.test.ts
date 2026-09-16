import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { setDbProvider, storageFolderPath, updateOwnedStorageFolder } from "@beutl/db";

const connectionString = process.env.TEST_DATABASE_URL;
const describeWithCockroach = connectionString ? describe : describe.skip;

describeWithCockroach(
  "Storage folder ancestors on CockroachDB (set TEST_DATABASE_URL to run)",
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
      setDbProvider(async () => prisma);
    });
    beforeEach(async () => {
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
