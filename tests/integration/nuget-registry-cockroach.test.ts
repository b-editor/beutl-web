import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import { setR2BucketProvider } from "@beutl/api/ai/r2-provider";
import { createDevPackage, existsPackageName, PackageIdentityReservedError, createRelease, updateRelease, ReleaseArtifactLockedError, ReleaseIdentityConflictError, setReleasePublishedByAdmin, setDbProvider, packageNameFilter, refreshNugetPackageMetadata, deleteReleaseWithStorageCleanup, updateDevPackageDisplay, updateDevPackageDescription, updateDevPackageTags } from "@beutl/db";
import { searchNugetPackages } from "../../packages/api/src/nuget/catalog";
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
  it.each([
    "9999999999.1.1", "v1.2147483648.0", "1.0.2147483648+build", "9007199254740991.0.0",
    `1.0.0+${"x".repeat(123)}`, "not-a-version",
  ])("rejects unsupported legacy version %s before schema changes", async (version) => {
    await db.$executeRaw`INSERT INTO "Release" ("id", "packageId", "version", "targetVersion", "title", "description", "published")
      VALUES ('unsupported', 'user', ${version}, '', '', '', true)`;
    try {
      await expect(db.$executeRawUnsafe(`${preflight}END $$;`)).rejects.toThrow("unsupported legacy versions");
      expect(await db.$queryRaw`SELECT column_name FROM information_schema.columns
        WHERE table_name = 'Release' AND column_name = 'nugetVersion' AND table_schema = 'public'`).toEqual([]);
    } finally { await db.$executeRaw`DELETE FROM "Release" WHERE "id" = 'unsupported'`; }
  });
  it.each(["v2147483647.2147483647.2147483647-beta+build", `2.0.0+${"x".repeat(122)}`])(
    "accepts supported legacy version at the boundary: %s", async (version) => {
      await db.$executeRaw`INSERT INTO "Release" ("id", "packageId", "version", "targetVersion", "title", "description", "published")
        VALUES ('boundary', 'user', ${version}, '', '', '', false)`;
      try { await expect(db.$executeRawUnsafe(`${preflight}END $$;`)).resolves.toBeDefined(); }
      finally { await db.$executeRaw`DELETE FROM "Release" WHERE "id" = 'boundary'`; }
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
  it("classifies legacy registration leaves before partitioning pages", async () => {
    const name = "Registration.Pages", packageId = "registration-pages";
    const broken = new Set([0, 64, 69]);
    const manifest = (version: string) => `<package><metadata><id>${name}</id><version>${version}</version><authors>Owner</authors><description>SDK</description></metadata></package>`;
    const semver2 = zipSync({ "Library.nuspec": strToU8(manifest("1.0.31").replace("</metadata>",
      '<dependencies><dependency id="Dependency" version="[1.0.0-beta.1,2.0)" /></dependencies></metadata>')) });
    const archives = { broken: strToU8("not a ZIP"), semver2 };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const get = vi.fn(async (key: keyof typeof archives, options) => ({
      arrayBuffer: async () => archives[key].slice(options.range.offset, options.range.offset + options.range.length).buffer,
    }));
    setR2BucketProvider(() => ({ get }) as never);
    await db.$executeRaw`INSERT INTO "Package" ("id", "name", "audience") VALUES (${packageId}, ${name}, 'DEVELOPMENT')`;
    for (const [key, bytes] of Object.entries(archives)) await db.$executeRaw`
      INSERT INTO "File" ("id", "name", "objectKey", "size") VALUES (${`${packageId}-${key}`}, 'legacy.nupkg', ${key}, ${BigInt(bytes.length)})`;
    try {
      await db.release.createMany({ data: Array.from({ length: 70 }, (_, i) => ({
        id: `${packageId}-${String(i).padStart(2, "0")}`, packageId, version: `1.0.${i}`, nugetVersion: `1.0.${i}`,
        published: true, title: "", description: "", targetVersion: "",
        fileId: broken.has(i) ? `${packageId}-broken` : i === 31 ? `${packageId}-semver2` : "original",
        nugetMetadata: broken.has(i) || i === 31 ? Prisma.DbNull : parseNuspec(manifest(`1.0.${i}`)),
      })) });
      for (const hive of ["registration-semver1", "registration"]) {
        const expected = Array.from({ length: 70 }, (_, i) => i)
          .filter((i) => !broken.has(i) && (hive === "registration" || i !== 31)).map((i) => `1.0.${i}`);
        const indexResponse = await nugetApp.request(`https://nuget.test/v3/${hive}/registration.pages/index.json`);
        expect(indexResponse.status).toBe(200);
        const index = await indexResponse.json();
        expect(index.count).toBe(2);
        const versions: string[] = [];
        for (const descriptor of index.items) {
          const response = await nugetApp.request(descriptor["@id"]);
          expect(response.status).toBe(200);
          const page = await response.json();
          const leaves = page.items.map((item: { catalogEntry: { version: string } }) => item.catalogEntry.version);
          expect(page.count).toBe(leaves.length);
          expect(page).toMatchObject({ count: descriptor.count, lower: descriptor.lower, upper: descriptor.upper });
          expect(page.lower).toBe(leaves[0]);
          expect(page.upper).toBe(leaves.at(-1));
          expect(page.count).toBeLessThanOrEqual(64);
          versions.push(...leaves);
        }
        expect(versions).toEqual(expected);
      }
      expect(await db.release.findUniqueOrThrow({ where: { id: `${packageId}-31` } })).toMatchObject({ nugetSemVer2: true });
      expect(get).toHaveBeenCalled();
    } finally {
      await db.release.deleteMany({ where: { packageId } });
      await db.package.delete({ where: { id: packageId } });
      await db.file.deleteMany({ where: { id: { in: [`${packageId}-broken`, `${packageId}-semver2`] } } });
      errors.mockRestore();
    }
  });
  it.each(["DEVELOPMENT", "USER"] as const)("allows editorial updates only for user packages (%s)", async (audience) => {
    const pkg = await createDevPackage({ name: `Editorial.${audience}`, audience, userId: "owner" });
    try {
      const edits = [
        () => updateDevPackageDisplay({ packageId: pkg.id, displayName: "Editorial", shortDescription: "Summary" }),
        () => updateDevPackageDescription({ packageId: pkg.id, description: "Editorial description" }),
        () => updateDevPackageTags({ packageId: pkg.id, tags: ["editorial"] }),
      ];
      for (const edit of edits) {
        if (audience === "DEVELOPMENT") await expect(edit()).rejects.toMatchObject({ code: "P2025" });
        else await expect(edit()).resolves.toMatchObject({ name: pkg.name });
      }
      const stored = await db.package.findUniqueOrThrow({ where: { id: pkg.id } });
      expect(stored).toMatchObject(audience === "DEVELOPMENT"
        ? { displayName: pkg.displayName, shortDescription: pkg.shortDescription, description: pkg.description, tags: pkg.tags }
        : { displayName: "Editorial", shortDescription: "Summary", description: "Editorial description", tags: ["editorial"] });
    } finally { await db.package.delete({ where: { id: pkg.id } }); }
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
  it.each([
    ["search", "semver2", 0], ["autocomplete", "semver2", 0], ["search", "unreadable", 0], ["autocomplete", "unreadable", 0],
    ["search", "semver2", 21], ["autocomplete", "semver2", 21], ["search", "unreadable", 21], ["autocomplete", "unreadable", 21],
    ["store", "unreadable", 0], ["store", "unreadable", 21],
  ] as const)("fills %s pages excluding a %s legacy package at index %s", async (resource, kind, badIndex) => {
    const prefix = `Page.${resource}.${kind}`;
    const names = Array.from({ length: 22 }, (_, i) => `${prefix}.${String(i).padStart(2, "0")}`);
    const manifest = (name: string) => `<package><metadata><id>${name}</id><version>1.0.0</version><authors>Owner</authors><description>Library</description></metadata></package>`;
    const bytes = kind === "unreadable" ? strToU8("not a ZIP") : zipSync({ "Library.nuspec": strToU8(manifest(names[badIndex])
      .replace("</metadata>", '<dependencies><dependency id="Dependency" version="[1.0.0-beta.1,2.0)" /></dependencies></metadata>')) });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    setR2BucketProvider(() => ({ get: async (_key, options) => ({
      arrayBuffer: async () => bytes.slice(options!.range!.offset, options!.range!.offset + options!.range!.length).buffer,
    }) }) as never);
    await db.$executeRaw`INSERT INTO "File" ("id", "name", "size") VALUES (${prefix}, 'legacy.nupkg', ${BigInt(bytes.length)})`;
    try {
      for (const [i, name] of names.entries()) {
        await db.$executeRaw`INSERT INTO "Package" ("id", "name", "audience") VALUES (${name}, ${name}, 'DEVELOPMENT')`;
        await db.release.create({ data: { id: name, packageId: name, version: "1.0.0", nugetVersion: "1.0.0", published: true,
          title: "", description: "", targetVersion: "", fileId: prefix, nugetMetadata: i !== badIndex ? parseNuspec(manifest(name)) : Prisma.DbNull } });
      }
      if (resource === "store") await db.release.create({ data: {
        packageId: names[10], version: "2.0.0", nugetVersion: "2.0.0", published: true, fileId: prefix,
        title: "", description: "", targetVersion: "",
      } });
      const page = async (skip: number) => {
        if (resource === "store") {
          const result = await searchNugetPackages({ query: prefix, audience: "DEVELOPMENT", skip, take: 20, filterReadable: true });
          expect(result.totalHits).toBe(21);
          expect(result.packages.flatMap((pkg) => pkg.Release).every((r) => r.version === "1.0.0")).toBe(true);
          return result.packages.map((pkg) => pkg.name);
        }
        const response = await nugetApp.request(`https://nuget.test/v3/${resource}?q=${prefix}&take=20&skip=${skip}`);
        expect(response.status).toBe(200);
        const result = await response.json();
        expect(result.totalHits).toBe(21);
        return resource === "search" ? result.data.map((item: { id: string }) => item.id) : result.data;
      };
      const expected = names.filter((_, i) => i !== badIndex);
      // Exercise both direct later-page navigation and a cold first-page request
      // with an incompatible candidate beyond the page boundary.
      if (badIndex === 0) expect(await page(20)).toEqual(expected.slice(20));
      const first = await page(0), last = await page(20);
      expect(first).toHaveLength(20);
      expect([...first, ...last]).toEqual(expected);
      if (resource !== "store") {
        const empty = await (await nugetApp.request(`https://nuget.test/v3/${resource}?q=${prefix}&take=0`)).json();
        expect(empty).toEqual({ totalHits: 21, data: [] });
      }
    } finally {
      await db.release.deleteMany({ where: { packageId: { in: names } } });
      await db.package.deleteMany({ where: { id: { in: names } } });
      await db.file.delete({ where: { id: prefix } });
      errors.mockRestore();
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
  it.each(["DEVELOPMENT", "USER"] as const)("keeps %s search metadata consistent after moderation and deletion", async (audience) => {
    const packageId = `metadata-${audience}`, name = `Metadata.${audience}`;
    await db.$executeRaw`INSERT INTO "Package" ("id", "name", "audience", "displayName", "description", "shortDescription", "tags", "webSite")
      VALUES (${packageId}, ${name}, ${audience}, 'Editorial title', 'Editorial description', 'Editorial summary', ARRAY['editorial'], 'https://editorial.test')`;
    // Exercise metadata transactions independently of the separately tested storage cleanup.
    await db.$executeRaw`INSERT INTO "File" ("id", "name", "userId") VALUES (${packageId}, 'sdk.nupkg', 'artifact-owner')`;
    const editorial = { displayName: "Editorial title", description: "Editorial description", shortDescription: "Editorial summary", tags: ["editorial"], webSite: "https://editorial.test" };
    const ids = [];
    for (const [version, word] of [["1.0.0", "previous"], ["2.0.0", "latest"]]) {
      const nuspec = `<package><metadata><id>${name}</id><version>${version}</version><authors>Owner</authors><title>${word}</title>
        <description>${word} description</description><summary>${word} summary</summary><tags>${word}</tags><projectUrl>https://${word}.test</projectUrl></metadata></package>`;
      const release = await draft(packageId, version);
      await updateRelease({ id: release.id, published: false, fileId: packageId, title: "", description: "", targetVersion: "",
        nuget: { metadata: parseNuspec(nuspec), nuspec, readme: null } });
      ids.push(release.id);
      await setReleasePublishedByAdmin({ releaseId: release.id, published: true });
    }
    const check = async (word?: string) => {
      const expected = audience === "USER" ? editorial : word
        ? { displayName: word, description: `${word} description`, shortDescription: `${word} summary`, tags: [word], webSite: `https://${word}.test` }
        : { displayName: null, description: "", shortDescription: "", tags: [], webSite: "" };
      expect(await db.package.findUniqueOrThrow({ where: { id: packageId } })).toMatchObject(expected);
      if (audience === "DEVELOPMENT") {
        for (const query of ["latest", "previous"]) {
          const result = await searchNugetPackages({ query });
          expect(result.packages.some((pkg) => pkg.id === packageId)).toBe(query === word);
        }
      }
    };
    await check("latest");
    await expect(db.$transaction(async (tx) => {
      await setReleasePublishedByAdmin({ releaseId: ids[1], published: false, prisma: tx });
      throw new Error("Rollback visibility change");
    })).rejects.toThrow("Rollback visibility change");
    expect((await db.release.findUniqueOrThrow({ where: { id: ids[1] } })).published).toBe(true);
    await check("latest");
    await setReleasePublishedByAdmin({ releaseId: ids[1], published: false });
    await check("previous");
    await setReleasePublishedByAdmin({ releaseId: ids[1], published: true });
    await check("latest");
    await expect(db.$transaction(async (tx) => {
      await deleteReleaseWithStorageCleanup({ id: ids[1], userId: "owner", prisma: tx });
      throw new Error("Rollback deletion");
    })).rejects.toThrow("Rollback deletion");
    expect(await db.release.findUnique({ where: { id: ids[1] } })).not.toBeNull();
    await check("latest");
    await deleteReleaseWithStorageCleanup({ id: ids[1], userId: "owner" });
    await check("previous");
    await deleteReleaseWithStorageCleanup({ id: ids[0], userId: "owner" });
    await check();
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
