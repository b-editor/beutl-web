import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDevPackage, existsPackageName, PackageIdentityReservedError, createRelease, updateRelease, ReleaseArtifactLockedError, ReleaseIdentityConflictError, setReleasePublishedByAdmin, setDbProvider, packageNameFilter } from "@beutl/db";
import { refreshNugetPackageMetadata, searchNugetPackages } from "../../packages/api/src/nuget/catalog";
import { parseNuspec } from "../../packages/api/src/nuget/archive";
import nugetApp from "../../packages/api/src/nuget/app";

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;

suite("NuGet publication invariants on CockroachDB", () => {
  const database = `nuget_${randomUUID().replaceAll("-", "")}`;
  let admin: PrismaClient, db: PrismaClient;
  let preflight: string, ddl: string;
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
      `CREATE TABLE "File" ("id" STRING PRIMARY KEY, "name" STRING NOT NULL,
        "size" INT8 NOT NULL DEFAULT 4, "mimeType" STRING NOT NULL DEFAULT 'application/octet-stream',
        "objectKey" STRING NOT NULL DEFAULT 'object', "userId" STRING NOT NULL DEFAULT 'owner',
        "sha256" STRING, "visibility" STRING NOT NULL DEFAULT 'DEDICATED', "folderId" STRING,
        "storageMoveLeaseToken" STRING, "storageMoveLeaseUntil" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT current_timestamp(), "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT current_timestamp())`,
      `CREATE TABLE "Package" ("id" STRING PRIMARY KEY, "name" STRING NOT NULL UNIQUE,
        "displayName" STRING, "description" STRING NOT NULL DEFAULT '', "shortDescription" STRING NOT NULL DEFAULT '',
        "published" BOOL NOT NULL DEFAULT true, "webSite" STRING NOT NULL DEFAULT '', "tags" STRING[] NOT NULL DEFAULT '{}',
        "iconFileId" STRING, "userId" STRING NOT NULL DEFAULT 'owner', "interval" STRING,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT current_timestamp(), "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT current_timestamp())`,
      `CREATE TABLE "Release" ("id" STRING PRIMARY KEY, "packageId" STRING NOT NULL REFERENCES "Package" ("id"),
        "version" STRING NOT NULL, "targetVersion" STRING NOT NULL, "title" STRING NOT NULL, "description" STRING NOT NULL,
        "fileId" STRING REFERENCES "File" ("id"), "published" BOOL NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT current_timestamp(), "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT current_timestamp())`,
      `INSERT INTO "File" ("id", "name") VALUES ('original', 'original.nupkg'), ('replacement', 'replacement.nupkg')`,
      `INSERT INTO "Package" ("id", "name") VALUES ('user', 'User.Package'), ('dev', 'Dev.Package')`,
      `INSERT INTO "Release" ("id", "packageId", "version", "targetVersion", "title", "description", "fileId", "published") VALUES
        ('published', 'user', 'v1.0.0+linux-x64', '1.0.0', '', '', 'original', true),
        ('draft', 'dev', '1.0.0', '', '', '', 'original', false)`,
    ]) await db.$executeRawUnsafe(sql);
    const sql = await readFile(new URL("../../packages/db/prisma/migrations/20261013000000_nuget_registry/migration.sql", import.meta.url), "utf8");
    [preflight, ddl] = sql.split("END $$;");
  }, 90000);
  afterAll(async () => { await db?.$disconnect(); if (admin) { await admin.$executeRawUnsafe(`DROP DATABASE "${database}" CASCADE`); await admin.$disconnect(); } });
  const edit = (id: string, published: boolean, fileId?: string) => updateRelease({ id, published, fileId, title: "Title", description: "Description", targetVersion: "1.0.0" });
  const draft = (packageId: string, version: string) => createRelease({ packageId, version, title: "Title", description: "Description", targetVersion: "1.0.0", published: false });

  it.each(["foo..bar", ".foo", "foo."])("rejects legacy ID %s before schema changes", async (name) => {
    await db.$executeRaw`INSERT INTO "Package" ("id", "name") VALUES ('legacy-id', ${name})`;
    try {
      await expect(db.$executeRawUnsafe(`${preflight}END $$;`)).rejects.toThrow("unsupported legacy IDs");
      expect(await db.$queryRaw`SELECT column_name FROM information_schema.columns
        WHERE table_name = 'Package' AND column_name = 'audience' AND table_schema = 'public'`).toEqual([]);
    } finally { await db.$executeRaw`DELETE FROM "Package" WHERE "id" = 'legacy-id'`; }
  });
  it.each([["1.0.0", true], ["v1.0.0+other-build", true], ["1.0.0+draft", false]])(
    "rejects colliding legacy version %s (published: %s) before changing schema", async (version, published) => {
      await db.$executeRaw`INSERT INTO "Release" ("id", "packageId", "version", "targetVersion", "title", "description", "published")
        VALUES ('collision', 'user', ${version}, '', '', '', ${published})`;
      try {
        await expect(db.$executeRawUnsafe(`${preflight}END $$;`)).rejects.toThrow("duplicate normalized versions");
        const columns = await db.$queryRaw`SELECT column_name FROM information_schema.columns
          WHERE table_name = 'Release' AND column_name = 'nugetVersion' AND table_schema = 'public'`;
        expect(columns).toEqual([]);
      } finally {
        await db.$executeRaw`DELETE FROM "Release" WHERE "id" = 'collision'`;
      }
    },
  );
  it("backfills canonical identities and locks only currently published releases", async () => {
    await db.$executeRawUnsafe(`${preflight}END $$;`);
    for (const statement of ddl.split(";").filter((s) => s.trim())) await db.$executeRawUnsafe(statement);
    await db.$executeRawUnsafe(`UPDATE "Release" SET "nugetMetadata" = '{"version":"1.0.0","dependencyGroups":[{"dependencies":[{"range":"[1.0.0-beta.1,2.0.0)"}]}]}'::JSONB WHERE "id" = 'draft'`);
    const semverMigration = await readFile(new URL("../../packages/db/prisma/migrations/20261016000000_nuget_semver_level/migration.sql", import.meta.url), "utf8");
    for (const statement of semverMigration.split(";").filter((s) => s.trim())) await db.$executeRawUnsafe(statement);
    await db.$executeRawUnsafe(`UPDATE "Package" SET "audience" = 'DEVELOPMENT' WHERE "id" = 'dev'`);
    expect(await db.release.findUniqueOrThrow({ where: { id: "published" } })).toMatchObject({
      artifactLocked: true, version: "v1.0.0+linux-x64", nugetVersion: "1.0.0", nugetSemVer2: true,
    });
    expect(await db.release.findUniqueOrThrow({ where: { id: "draft" } })).toMatchObject({ artifactLocked: false, nugetVersion: "1.0.0", nugetSemVer2: true });
    expect(await db.publishedPackageVersion.count()).toBe(1);
    expect(await db.publishedPackageVersion.findUniqueOrThrow({ where: { releaseId: "published" } }))
      .toMatchObject({ name: "user.package", version: "1.0.0" });
  }, 90000);
  it("isolates SemVer 2 versions and dependency bounds from legacy registration", async () => {
    await db.$executeRaw`INSERT INTO "Package" ("id", "name", "audience") VALUES ('registration', 'Registration.Package', 'DEVELOPMENT')`;
    const versions = ["1.0.0", "2.0.0+build", "3.0.0-beta.1", "4.0.0"];
    try {
      for (const [i, version] of versions.entries()) {
        const nuspec = `<package><metadata><id>Registration.Package</id><version>${version}</version><authors>Owner</authors><description>SDK</description>
          ${i === 3 ? '<dependencies><dependency id="Dependency" version="[1.0.0-beta.1,2.0)" /></dependencies>' : ""}</metadata></package>`;
        const r = await draft("registration", version);
        await updateRelease({ id: r.id, title: "SDK", description: "SDK", targetVersion: "", published: true, fileId: "original",
          nuget: { metadata: parseNuspec(nuspec), nuspec, readme: null } });
      }
      for (const [hive, expected] of [["registration", ["1.0.0", "2.0.0", "3.0.0-beta.1", "4.0.0"]], ["registration-semver1", ["1.0.0"]]] as const) {
        const base = `https://nuget.test/v3/${hive}/registration.package`;
        const index = await (await nugetApp.request(`${base}/index.json`)).json();
        expect(index.items[0].items.map((item: { catalogEntry: { version: string } }) => item.catalogEntry.version)).toEqual(expected);
        const page = await (await nugetApp.request(`${base}/page/1.0.0/4.0.0.json`)).json();
        expect(page.items.map((item: { catalogEntry: { version: string } }) => item.catalogEntry.version)).toEqual(expected);
        expect((await nugetApp.request(`${base}/1.0.0.json`)).status).toBe(200);
        for (const version of ["2.0.0", "3.0.0-beta.1", "4.0.0"]) {
          expect((await nugetApp.request(`${base}/${version}.json`)).status).toBe(hive === "registration" ? 200 : 404);
        }
      }
    } finally {
      await db.release.deleteMany({ where: { packageId: "registration" } });
      await db.package.delete({ where: { id: "registration" } });
    }
  });
  it("keeps stable build metadata in search counts and pagination", async () => {
    for (const [id, version, canonical] of [
      ["A.Build", "1.0.0+linux-x64", "1.0.0"],
      ["B.Preview", "2.0.0-beta+linux-x64", "2.0.0-beta"],
      ["C.Build", "3.0.0+ci-build", "3.0.0"],
    ]) {
      await db.$executeRaw`INSERT INTO "Package" ("id", "name", "audience") VALUES (${id}, ${id}, 'DEVELOPMENT')`;
      await db.$executeRaw`INSERT INTO "Release" ("id", "packageId", "version", "nugetVersion", "nugetSemVer2", "targetVersion", "title", "description", "fileId", "published")
        VALUES (${id}, ${id}, ${version}, ${canonical}, true, '', '', '', 'original', true)`;
    }
    try {
      const stable = await searchNugetPackages({ prerelease: false, audience: "DEVELOPMENT", skip: 1, take: 1 });
      expect(stable.totalHits).toBe(2);
      expect(stable.packages.map((pkg) => pkg.name)).toEqual(["C.Build"]);
      const all = await searchNugetPackages({ prerelease: true, audience: "DEVELOPMENT", skip: 1, take: 1 });
      expect(all.totalHits).toBe(3);
      expect(all.packages.map((pkg) => pkg.name)).toEqual(["B.Preview"]);
      const legacy = await searchNugetPackages({ prerelease: true, semVer2: false, audience: "DEVELOPMENT", take: 1 });
      expect(legacy).toMatchObject({ totalHits: 0, packages: [] });
    } finally {
      await db.release.deleteMany({ where: { id: { in: ["A.Build", "B.Preview", "C.Build"] } } });
      await db.package.deleteMany({ where: { id: { in: ["A.Build", "B.Preview", "C.Build"] } } });
    }
  });
  it("keeps search terms in sync when the highest SDK version is unlisted and relisted", async () => {
    const pkg = await createDevPackage({ name: "Search.Package", audience: "DEVELOPMENT", userId: "owner" });
    await db.package.update({ where: { id: pkg.id }, data: { published: true } });
    const ids = [];
    for (const [version, description] of [["1.0.0", "Old searchable"], ["2.0.0", "New searchable"]]) {
      const r = await draft(pkg.id, version);
      ids.push(r.id);
      const nuspec = `<package><metadata><id>Search.Package</id><version>${version}</version><authors>Author</authors><description>${description}</description></metadata></package>`;
      await updateRelease({ id: r.id, published: true, fileId: "original", title: "", description: "", targetVersion: "",
        nuget: { metadata: parseNuspec(nuspec), nuspec, readme: null } });
    }
    for (const listed of [false, true]) {
      await db.$transaction(async (tx) => {
        await tx.release.update({ where: { id: ids[1] }, data: { nugetListed: listed } });
        const current = await tx.package.findUniqueOrThrow({ where: { id: pkg.id }, include: { Release: { include: { file: true } } } });
        await refreshNugetPackageMetadata(tx, current);
      });
      expect((await searchNugetPackages({ query: listed ? "New searchable" : "Old searchable" })).totalHits).toBe(1);
      expect((await searchNugetPackages({ query: listed ? "Old searchable" : "New searchable" })).totalHits).toBe(0);
    }
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
  it("permanently reserves a published ID after project deletion", async () => {
    await db.release.deleteMany({ where: { packageId: "user" } });
    await db.package.delete({ where: { id: "user" } });
    expect(await existsPackageName({ name: "USER.PACKAGE" })).toBeGreaterThan(0);
    for (const audience of ["USER", "DEVELOPMENT"] as const) {
      await expect(createDevPackage({ name: "USER.PACKAGE", audience, userId: "other" })).rejects.toBeInstanceOf(PackageIdentityReservedError);
    }
    expect(await db.package.count({ where: { name: packageNameFilter("User.Package") } })).toBe(0);
  });
});
