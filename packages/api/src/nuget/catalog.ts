import { packageNameFilter } from "@beutl/db";
import { compareNugetVersions, normalizeNugetId, normalizeNugetVersion, requiresNugetSemVer2, type NugetMetadata, type PackageAudience } from "@beutl/core";
import { getDb, type PrismaTransaction } from "@beutl/db";
import type { Prisma } from "@prisma/client";
import { readNugetPackage, storedPackageReader } from "./archive";

export async function findNugetPackage(id: string, audience?: PackageAudience) {
  return (await getDb()).package.findFirst({
    where: { name: packageNameFilter(normalizeNugetId(id)), published: true, audience },
    include: { Release: { where: { published: true, fileId: { not: null } }, include: { file: true } } },
  });
}

export type NugetPackage = NonNullable<Awaited<ReturnType<typeof findNugetPackage>>>;
export type NugetRelease = NugetPackage["Release"][number];

// Catalog responses need neither the manifest text nor the embedded readme.
export const catalogReleaseSelect = {
  id: true, version: true, nugetListed: true, nugetMetadata: true,
  fileId: true, file: true, downloads: true, createdAt: true,
} satisfies Prisma.ReleaseSelect;
export type CatalogRelease = Prisma.ReleaseGetPayload<{ select: typeof catalogReleaseSelect }>;
type ArchiveRelease = Pick<NugetRelease, "id" | "version" | "fileId" | "file" | "nugetMetadata" | "nuspec" | "readme">;

export function nugetSearchableMetadata(metadata: NugetMetadata) {
  return { displayName: metadata.title, description: metadata.description,
    shortDescription: metadata.summary || metadata.description.slice(0, 200), tags: metadata.tags, webSite: metadata.projectUrl };
}

export async function refreshNugetPackageMetadata(tx: PrismaTransaction, pkg: NugetPackage) {
  if (pkg.audience !== "DEVELOPMENT") return;
  for (const release of sortNugetReleases(pkg.Release.filter((r) => r.published && r.nugetListed && r.fileId))) {
    const parsed = await tryReleaseMetadata(pkg, release, tx);
    if (!parsed) continue;
    await tx.package.update({ where: { id: pkg.id }, data: nugetSearchableMetadata(parsed.metadata) });
    return;
  }
  await tx.package.update({ where: { id: pkg.id }, data: {
    displayName: null, description: "", shortDescription: "", tags: [], webSite: "",
  } });
}

export function sortNugetReleases<T extends { version: string }>(releases: T[]): T[] {
  return [...releases].sort((a, b) => compareNugetVersions(b.version, a.version));
}

export function findNugetVersion(pkg: NugetPackage, version: string) {
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
        nugetSemVer2: requiresNugetSemVer2(release.version, parsed.metadata) },
    });
  } catch (error) {
    console.error("Failed to cache NuGet release metadata", release.id, error);
  }
  return parsed;
}

export async function tryReleaseMetadata(pkg: Pick<NugetPackage, "name">, release: ArchiveRelease, prisma?: PrismaTransaction) {
  try {
    return await releaseMetadata(pkg, release, prisma);
  } catch (error) {
    console.error("Skipping unreadable NuGet release", release.id, error);
    return null;
  }
}

export async function catalogMetadata(pkg: Pick<NugetPackage, "name">, release: CatalogRelease) {
  return release.nugetMetadata as NugetMetadata | null ??
    (await tryReleaseMetadata(pkg, { ...release, nuspec: null, readme: null }))?.metadata ?? null;
}

export async function searchNugetPackages({ query = "", skip = 0, take = 20, prerelease = true, semVer2 = true, audience }: {
  query?: string; skip?: number; take?: number; prerelease?: boolean; semVer2?: boolean; audience?: PackageAudience;
}) {
  const releaseWhere: Prisma.ReleaseWhereInput = { published: true, nugetListed: true, fileId: { not: null },
    ...(!semVer2 ? { nugetSemVer2: false } : {}),
    ...(!prerelease ? { NOT: { nugetVersion: { contains: "-" } } } : {}) };
  const where: Prisma.PackageWhereInput = { published: true, audience, Release: { some: releaseWhere },
    ...(query.trim() ? { OR: [
      { name: { contains: query.trim(), mode: "insensitive" } },
      { displayName: { contains: query.trim(), mode: "insensitive" } },
      { description: { contains: query.trim(), mode: "insensitive" } },
      { tags: { has: query.trim() } },
    ] } : {}),
  };
  const db = await getDb();
  const [totalHits, packages] = await Promise.all([
    db.package.count({ where }),
    db.package.findMany({ where, orderBy: { name: "asc" }, skip: Math.max(0, skip), take: Math.max(1, Math.min(100, take)),
      include: { Release: { where: releaseWhere, select: catalogReleaseSelect } } }),
  ]);
  return { totalHits, packages };
}
