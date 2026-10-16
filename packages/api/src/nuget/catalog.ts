import { packageNameFilter } from "@beutl/db";
import { compareNugetVersions, normalizeNugetId, normalizeNugetVersion, requiresNugetSemVer2, type NugetMetadata, type PackageAudience } from "@beutl/core";
import { getDb, type PrismaTransaction } from "@beutl/db";
import { Prisma } from "@prisma/client";
import { InvalidNugetPackageError, readNugetPackage, storedPackageReader } from "./archive";

export async function findNugetPackage(id: string, audience: PackageAudience | undefined, version: string) {
  return (await getDb()).package.findFirst({
    where: { name: packageNameFilter(normalizeNugetId(id)), published: true, audience },
    include: { Release: { where: { published: true, fileId: { not: null },
      nugetVersion: normalizeNugetVersion(version) }, include: { file: true } } },
  });
}

export async function findNugetPackageVersions(id: string, audience?: PackageAudience) {
  return (await getDb()).package.findFirst({
    where: { name: packageNameFilter(normalizeNugetId(id)), published: true, audience },
    select: { name: true, Release: {
      where: { published: true, fileId: { not: null }, nugetMetadataInvalid: false },
      select: { id: true, version: true, nugetListed: true },
    } },
  });
}

export type NugetPackage = NonNullable<Awaited<ReturnType<typeof findNugetPackage>>>;
export type NugetRelease = NugetPackage["Release"][number];

// Catalog responses need neither the manifest text nor the embedded readme.
export const catalogReleaseSelect = {
  id: true, version: true, nugetListed: true, nugetMetadata: true, nugetMetadataInvalid: true, nugetSemVer2: true,
  fileId: true, file: true, downloads: true, createdAt: true,
} satisfies Prisma.ReleaseSelect;
export type CatalogRelease = Prisma.ReleaseGetPayload<{ select: typeof catalogReleaseSelect }>;
type CatalogPackage = Prisma.PackageGetPayload<{ include: { Release: { select: typeof catalogReleaseSelect } } }>;
type ArchiveRelease = Pick<NugetRelease, "id" | "version" | "fileId" | "file" | "nugetMetadata" | "nugetMetadataInvalid" | "nuspec" | "readme">;

export function sortNugetReleases<T extends { version: string }>(releases: T[]): T[] {
  return [...releases].sort((a, b) => compareNugetVersions(b.version, a.version));
}

export function findNugetVersion<T extends { version: string }>(pkg: { Release: T[] }, version: string) {
  const normalized = normalizeNugetVersion(version);
  return pkg.Release.find((r) => normalizeNugetVersion(r.version) === normalized);
}

export async function releaseMetadata(pkg: Pick<NugetPackage, "name">, release: ArchiveRelease, prisma?: PrismaTransaction) {
  if (release.nugetMetadata && release.nuspec) return {
    metadata: release.nugetMetadata as NugetMetadata, nuspec: release.nuspec, readme: release.readme,
  };
  if (!release.file) throw new Error("Package file is missing");
  const parsed = await readNugetPackage(storedPackageReader(release.file.objectKey, Number(release.file.size)), { id: pkg.name, version: release.version });
  // Cache legacy metadata only while it still describes the same attached file.
  try {
    await (prisma ?? await getDb()).release.updateMany({
      where: { id: release.id, fileId: release.fileId, version: release.version },
      data: { nugetMetadata: parsed.metadata, nuspec: parsed.nuspec, readme: parsed.readme,
        nugetMetadataInvalid: false,
        nugetSemVer2: requiresNugetSemVer2(release.version, parsed.metadata) },
    });
  } catch (error) {
    console.error("Failed to cache NuGet release metadata", release.id, error);
  }
  return parsed;
}

export async function tryReleaseMetadata(pkg: Pick<NugetPackage, "name">, release: ArchiveRelease, prisma?: PrismaTransaction) {
  if (release.nugetMetadataInvalid) return null;
  try {
    return await releaseMetadata(pkg, release, prisma);
  } catch (error) {
    console.error("Skipping unreadable NuGet release", release.id, error);
    if (error instanceof InvalidNugetPackageError) {
      try {
        await (prisma ?? await getDb()).release.updateMany({
          where: { id: release.id, fileId: release.fileId, version: release.version,
            nugetMetadata: { equals: Prisma.AnyNull } },
          data: { nugetMetadataInvalid: true },
        });
      } catch (cacheError) {
        console.error("Failed to cache invalid NuGet release", release.id, cacheError);
      }
    }
    return null;
  }
}

export async function catalogMetadata(pkg: Pick<NugetPackage, "name">, release: CatalogRelease, semVer2 = true) {
  if (release.nugetMetadataInvalid) return null;
  if (!semVer2 && (release.nugetSemVer2 || requiresNugetSemVer2(release.version))) return null;
  const metadata = release.nugetMetadata as NugetMetadata | null ??
    (await tryReleaseMetadata(pkg, { ...release, nuspec: null, readme: null }))?.metadata ?? null;
  return metadata && (semVer2 || !requiresNugetSemVer2(release.version, metadata)) ? metadata : null;
}

export async function classifyNugetReleases(where: Prisma.ReleaseWhereInput, semVer2: boolean) {
  const db = await getDb();
  const unknown = { ...where, nugetMetadataInvalid: false, nugetMetadata: { equals: Prisma.AnyNull } };
  const excluded = new Set<string>();
  if (!await db.release.count({ where: unknown })) return excluded;
  // Only uncached releases need inspection. Cache invalid archives as well as
  // valid metadata so one bad artifact cannot trigger a catalog-wide scan.
  let after: string | undefined;
  while (true) {
    const batch = await db.release.findMany({
      where: { ...unknown, ...(after ? { id: { gt: after } } : {}) },
      orderBy: { id: "asc" }, take: 64,
      select: { ...catalogReleaseSelect, package: { select: { name: true } } },
    });
    if (!batch.length) break;
    for (const release of batch) {
      if (!await catalogMetadata(release.package, release, semVer2)) excluded.add(release.id);
      after = release.id;
    }
  }
  // Keep transient read/cache failures out of this response without persisting
  // them as invalid; a later request can retry them.
  return excluded;
}

async function matchingPackagePage(query: string, skip: number, take: number, prerelease: boolean, semVer2: boolean, audience: PackageAudience | undefined, idOnly: boolean) {
  const pattern = `%${query.replace(/[\\%_]/gu, "\\$&")}%`;
  // Choose the latest eligible nuspec and match its tags entirely in SQL.
  // Only the requested page's IDs cross the Worker/database boundary.
  const [page] = await (await getDb()).$queryRaw<{ totalHits: bigint; ids: string[] }[]>(Prisma.sql`
    WITH matching AS (
      SELECT p."id", p."name" FROM "Package" p
      CROSS JOIN LATERAL (
        SELECT r."nugetMetadata" FROM "Release" r
        WHERE r."packageId" = p."id" AND r."published" AND r."nugetListed" AND r."fileId" IS NOT NULL
          AND NOT r."nugetMetadataInvalid" AND r."nugetMetadata" IS NOT NULL AND r."nugetMetadata" <> 'null'::JSONB
          AND (${semVer2} OR NOT r."nugetSemVer2")
          AND (${prerelease} OR r."nugetVersion" NOT LIKE '%-%')
        -- Normalized identities have numeric core components and lowercase labels.
        -- Pad numeric labels to the version-length limit so beta.10 follows beta.9,
        -- with numeric labels below text and a shorter equal prefix below a longer one.
        ORDER BY string_to_array(split_part(r."nugetVersion", '-', 1), '.')::INT[] DESC,
          (r."nugetVersion" NOT LIKE '%-%') DESC,
          ARRAY(SELECT CASE WHEN label ~ '^[0-9]+$' THEN '0' || lpad(label, 128, '0') ELSE '1' || label END
            FROM unnest(string_to_array(substr(r."nugetVersion", length(split_part(r."nugetVersion", '-', 1)) + 2), '.'))
              WITH ORDINALITY AS labels(label, ordinal) ORDER BY ordinal) DESC
        LIMIT 1
      ) latest
      WHERE p."published" ${audience ? Prisma.sql`AND p."audience" = ${audience}::"PackageAudience"` : Prisma.empty}
        AND (p."name" ILIKE ${pattern} OR (${!idOnly} AND (latest."nugetMetadata"->>'title' ILIKE ${pattern}
          OR latest."nugetMetadata"->>'description' ILIKE ${pattern}
          OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(latest."nugetMetadata"->'tags') AS tag(value)
            WHERE lower(tag.value) = lower(${query})))))
    )
    SELECT (SELECT count(*) FROM matching) AS "totalHits",
      ARRAY(SELECT "id" FROM matching ORDER BY "name" LIMIT ${take} OFFSET ${skip}) AS ids
  `);
  return { totalHits: Number(page.totalHits), ids: page.ids };
}

export async function searchNugetPackages({ query = "", skip = 0, take = 20, prerelease = true, semVer2 = true, audience, filterReadable = false, idOnly = false }: {
  query?: string; skip?: number; take?: number; prerelease?: boolean; semVer2?: boolean; audience?: PackageAudience; filterReadable?: boolean; idOnly?: boolean;
}) {
  const releaseWhere: Prisma.ReleaseWhereInput = { published: true, nugetListed: true, fileId: { not: null }, nugetMetadataInvalid: false,
    // Historical archives are indexed by backfill:metadata before cutover.
    // Never extract archives from a catalog-wide search request: filtering and
    // counting must use the same already-validated metadata, even for take=0.
    nugetMetadata: { not: Prisma.AnyNull },
    ...(!semVer2 ? { nugetSemVer2: false } : {}),
    ...(!prerelease ? { NOT: { nugetVersion: { contains: "-" } } } : {}) };
  const term = query.trim();
  const db = await getDb();
  const where: Prisma.PackageWhereInput = { published: true, audience, Release: { some: releaseWhere } };
  const include = { Release: { where: releaseWhere, select: catalogReleaseSelect } };
  const offset = Math.max(0, skip), limit = Math.max(0, Math.min(100, take));
  const readable = async (pkg: CatalogPackage) => {
    const releases = [];
    for (const release of pkg.Release) {
      const metadata = release.nugetMetadata && await catalogMetadata(pkg, release, semVer2);
      if (metadata) releases.push({ ...release, nugetMetadata: metadata });
    }
    pkg.Release = releases;
    return releases.length > 0;
  };
  const page = term ? await matchingPackagePage(term, offset, limit, prerelease, semVer2, audience, idOnly) : null;
  if (page) where.id = { in: page.ids };
  const [totalHits, packages] = await Promise.all([
    page ? page.totalHits : db.package.count({ where }),
    db.package.findMany({ where, orderBy: { name: "asc" }, skip: page ? 0 : offset, take: limit, include }),
  ]);
  if (filterReadable) {
    const filtered = [];
    for (const pkg of packages) if (await readable(pkg)) filtered.push(pkg);
    return { totalHits, packages: filtered };
  }
  return { totalHits, packages };
}
