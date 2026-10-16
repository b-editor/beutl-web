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

async function userPackagesMatchingOlderMetadata(releaseWhere: Prisma.ReleaseWhereInput, metadataWhere: Prisma.ReleaseWhereInput, query: string) {
  const db = await getDb();
  const where: Prisma.PackageWhereInput = { published: true, audience: "USER",
    NOT: { name: { contains: query, mode: "insensitive" } },
    Release: { some: { ...releaseWhere, ...metadataWhere } },
  };
  const excluded: string[] = [];
  if (!await db.release.count({ where: { ...releaseWhere, package: where } })) return excluded;
  let after: string | undefined;
  while (true) {
    // Search JSON in SQL first, then check the latest eligible identity. Older
    // nuspec matches must not make a package match metadata it no longer shows.
    const batch = await db.package.findMany({
      where: { ...where, ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: "asc" }, take: 64,
      select: { id: true, Release: { where: releaseWhere, select: { id: true, version: true } } },
    });
    if (!batch.length) break;
    const latest = batch.map((pkg) => ({ packageId: pkg.id, release: sortNugetReleases(pkg.Release)[0] }));
    const matches = new Set((await db.release.findMany({
      where: { ...metadataWhere, id: { in: latest.flatMap(({ release }) => release ? [release.id] : []) } }, select: { id: true },
    })).map((release) => release.id));
    for (const { packageId, release } of latest) if (!release || !matches.has(release.id)) excluded.push(packageId);
    after = batch[batch.length - 1].id;
  }
  return excluded;
}

export async function searchNugetPackages({ query = "", skip = 0, take = 20, prerelease = true, semVer2 = true, audience, filterReadable = false }: {
  query?: string; skip?: number; take?: number; prerelease?: boolean; semVer2?: boolean; audience?: PackageAudience; filterReadable?: boolean;
}) {
  const releaseWhere: Prisma.ReleaseWhereInput = { published: true, nugetListed: true, fileId: { not: null }, nugetMetadataInvalid: false,
    ...(!semVer2 ? { nugetSemVer2: false } : {}),
    ...(!prerelease ? { NOT: { nugetVersion: { contains: "-" } } } : {}) };
  const term = query.trim();
  const metadataWhere: Prisma.ReleaseWhereInput = { OR: [
    { nugetMetadata: { path: ["title"], string_contains: term, mode: "insensitive" } },
    { nugetMetadata: { path: ["description"], string_contains: term, mode: "insensitive" } },
    { nugetMetadata: { path: ["tags"], array_contains: [term] } },
  ] };
  const baseWhere: Prisma.PackageWhereInput = { published: true, audience, Release: { some: releaseWhere } };
  const queryWhere: Prisma.PackageWhereInput = term ? { OR: [
    { name: { contains: term, mode: "insensitive" } },
    { audience: "DEVELOPMENT", OR: [
      { displayName: { contains: term, mode: "insensitive" } },
      { description: { contains: term, mode: "insensitive" } }, { tags: { has: term } },
    ] },
    { audience: "USER", Release: { some: { AND: [releaseWhere, metadataWhere] } } },
  ] } : {};
  const where: Prisma.PackageWhereInput = { ...baseWhere, ...queryWhere };
  const db = await getDb();
  const include = { Release: { where: releaseWhere, select: catalogReleaseSelect } };
  const offset = Math.max(0, skip), limit = Math.max(0, Math.min(100, take));
  const readable = async (pkg: CatalogPackage) => {
    const releases = [];
    for (const release of pkg.Release) {
      const metadata = await catalogMetadata(pkg, release, semVer2);
      if (metadata) releases.push({ ...release, nugetMetadata: metadata });
    }
    pkg.Release = releases;
    return releases.length > 0;
  };
  if (filterReadable || (term && audience !== "DEVELOPMENT")) {
    // A legacy USER nuspec may contain the search term even when the editable
    // store fields do not. Classify it before applying the metadata predicate.
    const excluded = await classifyNugetReleases({ ...releaseWhere,
      package: { ...baseWhere, ...(term ? { OR: [{ audience: "USER" }, queryWhere] } : {}) },
    }, semVer2);
    if (excluded.size) releaseWhere.id = { notIn: [...excluded] };
  }
  if (term && audience !== "DEVELOPMENT") {
    const excluded = await userPackagesMatchingOlderMetadata(releaseWhere, metadataWhere, term);
    if (excluded.length) where.id = { notIn: excluded };
  }
  const [totalHits, packages] = await Promise.all([
    db.package.count({ where }),
    db.package.findMany({ where, orderBy: { name: "asc" }, skip: offset, take: limit, include }),
  ]);
  if (filterReadable) {
    const filtered = [];
    for (const pkg of packages) if (await readable(pkg)) filtered.push(pkg);
    return { totalHits, packages: filtered };
  }
  return { totalHits, packages };
}
