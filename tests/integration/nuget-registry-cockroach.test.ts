import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRelease, updateRelease, ReleaseArtifactLockedError, ReleaseIdentityConflictError, setReleasePublishedByAdmin, setDbProvider, packageNameFilter } from "@beutl/db";

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;

suite("NuGet publication invariants on CockroachDB", () => {
  const database = `nuget_${randomUUID().replaceAll("-", "")}`;
  let admin: PrismaClient, db: PrismaClient;
  beforeAll(async () => {
    const url = new URL(connectionString!); url.pathname = "/defaultdb";
    admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
    url.pathname = `/${database}`;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
    setDbProvider(async () => db);
    // The pre-integration tables, including both current publication states.
    for (const sql of [
      `CREATE TABLE "User" ("id" STRING PRIMARY KEY)`,
      `CREATE TABLE "File" ("id" STRING PRIMARY KEY, "name" STRING NOT NULL)`,
      `CREATE TABLE "Package" ("id" STRING PRIMARY KEY, "name" STRING NOT NULL UNIQUE)`,
      `CREATE TABLE "Release" ("id" STRING PRIMARY KEY, "packageId" STRING NOT NULL REFERENCES "Package" ("id"),
        "version" STRING NOT NULL, "targetVersion" STRING NOT NULL, "title" STRING NOT NULL, "description" STRING NOT NULL,
        "fileId" STRING REFERENCES "File" ("id"), "published" BOOL NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT current_timestamp(), "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT current_timestamp())`,
      `INSERT INTO "File" VALUES ('original', 'original.nupkg'), ('replacement', 'replacement.nupkg')`,
      `INSERT INTO "Package" VALUES ('user', 'User.Package'), ('dev', 'Dev.Package')`,
      `INSERT INTO "Release" ("id", "packageId", "version", "targetVersion", "title", "description", "fileId", "published") VALUES
        ('published', 'user', '1.0.0', '1.0.0', '', '', 'original', true),
        ('draft', 'dev', '1.0.0', '', '', '', 'original', false)`,
    ]) await db.$executeRawUnsafe(sql);
    const sql = await readFile(new URL("../../packages/db/prisma/migrations/20261013000000_nuget_registry/migration.sql", import.meta.url), "utf8");
    const [preflight, ddl] = sql.split("END $$;");
    await db.$executeRawUnsafe(`${preflight}END $$;`);
    for (const statement of ddl.split(";").filter((s) => s.trim())) await db.$executeRawUnsafe(statement);
    await db.$executeRawUnsafe(`UPDATE "Package" SET "audience" = 'DEVELOPMENT' WHERE "id" = 'dev'`);
  }, 90000);
  afterAll(async () => { await db?.$disconnect(); if (admin) { await admin.$executeRawUnsafe(`DROP DATABASE "${database}" CASCADE`); await admin.$disconnect(); } });
  const edit = (id: string, published: boolean, fileId?: string) => updateRelease({ id, published, fileId, title: "Title", description: "Description", targetVersion: "1.0.0" });
  const draft = (packageId: string, version: string) => createRelease({ packageId, version, title: "Title", description: "Description", targetVersion: "1.0.0", published: false });

  it("locks only currently published releases when applying the schema", async () => {
    expect(await db.release.findUniqueOrThrow({ where: { id: "published" } })).toMatchObject({ artifactLocked: true });
    expect(await db.release.findUniqueOrThrow({ where: { id: "draft" } })).toMatchObject({ artifactLocked: false });
    expect(await db.publishedPackageVersion.count()).toBe(1);
  });
  it("permits replacing a current draft, but publication permanently locks its file", async () => {
    await edit("draft", false, "replacement");
    await edit("draft", true);
    await edit("draft", false);
    await expect(edit("draft", false, "original")).rejects.toBeInstanceOf(ReleaseArtifactLockedError);
    expect(await db.release.findUniqueOrThrow({ where: { id: "draft" } })).toMatchObject({ fileId: "replacement", artifactLocked: true, published: false });
  });
  it("locks admin publications and preserves editorial updates", async () => {
    const r = await draft("dev", "2.0.0");
    await edit(r.id, false, "original");
    expect(await setReleasePublishedByAdmin({ releaseId: r.id, published: true })).toMatchObject({ changed: true });
    await setReleasePublishedByAdmin({ releaseId: r.id, published: false });
    await expect(edit(r.id, false, "replacement")).rejects.toBeInstanceOf(ReleaseArtifactLockedError);
    await expect(edit(r.id, false)).resolves.toMatchObject({ title: "Title", artifactLocked: true });
  });
  it("reserves normalized identities after deleting a published release", async () => {
    await db.release.delete({ where: { id: "published" } });
    await expect(draft("user", "01.0.0.0+new-build")).rejects.toBeInstanceOf(ReleaseIdentityConflictError);
    await expect(db.$executeRawUnsafe(`INSERT INTO "Package" ("id", "name") VALUES ('other', 'USER.PACKAGE')`)).rejects.toThrow();
  });
  it("allows only one concurrent draft for equivalent normalized versions", async () => {
    const results = await Promise.allSettled([draft("dev", "3.0.0-Beta+one"), draft("dev", "03.0.0.0-beta+two")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.release.count({ where: { packageId: "dev", nugetVersion: "3.0.0-beta" } })).toBe(1);
  });
  it("matches underscores literally when checking case-insensitive package ownership", async () => {
    await db.$executeRawUnsafe(`INSERT INTO "Package" ("id", "name") VALUES ('underscore', 'Some_Library'), ('letter', 'SomeXLibrary')`);
    const matches = await db.package.findMany({ where: { name: packageNameFilter("SOME_LIBRARY") }, select: { id: true } });
    expect(matches).toEqual([{ id: "underscore" }]);
  });
  it("serializes competing publication and file replacement without unlocking a published file", async () => {
    const r = await draft("user", "4.0.0");
    await edit(r.id, false, "original");
    await Promise.allSettled([edit(r.id, true), edit(r.id, false, "replacement")]);
    const settled = await db.release.findUniqueOrThrow({ where: { id: r.id } });
    expect(settled.artifactLocked).toBe(true);
    await expect(edit(r.id, false, settled.fileId === "original" ? "replacement" : "original")).rejects.toBeInstanceOf(ReleaseArtifactLockedError);
  });
});
