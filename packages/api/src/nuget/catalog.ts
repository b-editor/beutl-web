import { packageNameFilter } from "@beutl/db";
import { compareNugetVersions, normalizeNugetId, normalizeNugetVersion, type NugetMetadata, type PackageAudience } from "@beutl/core";
import { getDb } from "@beutl/db";
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

export function sortNugetReleases<T extends { version: string }>(releases: T[]): T[] {
  return [...releases].sort((a, b) => compareNugetVersions(b.version, a.version));
}

export function findNugetVersion(pkg: NugetPackage, version: string) {
  const normalized = normalizeNugetVersion(version);
  return pkg.Release.find((r) => normalizeNugetVersion(r.version) === normalized);
}

export async function releaseMetadata(pkg: Pick<NugetPackage, "name">, release: NugetRelease) {
  if (release.nugetMetadata && release.nuspec) return {
    metadata: release.nugetMetadata as NugetMetadata, nuspec: release.nuspec, readme: release.readme,
  };
  if (!release.file) throw new Error("Package file is missing");
  const parsed = await readNugetPackage(storedPackageReader(release.file.objectKey, Number(release.file.size)), { id: pkg.name, version: release.version });
  // Cache legacy metadata only while it still describes the same attached file.
  try {
    await (await getDb()).release.updateMany({
      where: { id: release.id, fileId: release.fileId, version: release.version },
      data: { nugetMetadata: parsed.metadata, nuspec: parsed.nuspec, readme: parsed.readme },
    });
  } catch (error) {
    console.error("Failed to cache NuGet release metadata", release.id, error);
  }
  return parsed;
}

export async function tryReleaseMetadata(pkg: Pick<NugetPackage, "name">, release: NugetRelease) {
  try {
    return await releaseMetadata(pkg, release);
  } catch (error) {
    console.error("Skipping unreadable NuGet release", release.id, error);
    return null;
  }
}

export async function searchNugetPackages({ query = "", skip = 0, take = 20, prerelease = true, audience }: {
  query?: string; skip?: number; take?: number; prerelease?: boolean; audience?: PackageAudience;
}) {
  const releaseWhere: Prisma.ReleaseWhereInput = { published: true, nugetListed: true, fileId: { not: null },
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
      include: { Release: { where: releaseWhere, include: { file: true } } } }),
  ]);
  return { totalHits, packages };
}
