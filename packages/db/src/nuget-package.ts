import { compareNugetVersions, type NugetMetadata, type PackageAudience } from "@beutl/core";
import type { PrismaTransaction } from "./transaction";

export function nugetSearchableMetadata(metadata: NugetMetadata) {
  return { displayName: metadata.title, description: metadata.description,
    shortDescription: metadata.summary || metadata.description.slice(0, 200), tags: metadata.tags, webSite: metadata.projectUrl };
}

export async function refreshNugetPackageMetadata(tx: PrismaTransaction, pkg: { id: string; audience: PackageAudience }) {
  if (pkg.audience !== "DEVELOPMENT") return;
  // SDK uploads persist validated nuspec metadata before publication. Re-read
  // the remaining listed releases inside the mutation's transaction.
  const releases = await tx.release.findMany({
    where: { packageId: pkg.id, published: true, nugetListed: true, fileId: { not: null } },
    select: { version: true, nugetMetadata: true },
  });
  const latest = releases.filter((release) => release.nugetMetadata)
    .sort((a, b) => compareNugetVersions(b.version, a.version))[0];
  await tx.package.update({ where: { id: pkg.id }, data: latest
    ? nugetSearchableMetadata(latest.nugetMetadata as NugetMetadata)
    : { displayName: null, description: "", shortDescription: "", tags: [], webSite: "" } });
}
