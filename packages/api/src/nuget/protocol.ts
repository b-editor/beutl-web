import type { Context } from "hono";
import { NUGET_ORIGIN, normalizeNugetId, normalizeNugetVersion, nugetPackageUrl } from "@beutl/core";
import type { createStorageOperations } from "../storage/files";
import { catalogMetadata, sortNugetReleases, type NugetPackage, type CatalogRelease } from "./catalog";

export type NugetEnv = {
  Bindings: {
    NUGET_PUBLIC_ORIGIN?: string;
    execution?: Parameters<typeof createStorageOperations>[0];
  };
};

export function nugetOrigin(c: Context<NugetEnv>): string {
  return (c.env?.NUGET_PUBLIC_ORIGIN || NUGET_ORIGIN).replace(/\/$/u, "");
}

const resources = [
  ["/v3/package/", "PackageBaseAddress/3.0.0"],
  ["/v3/registration/", "RegistrationsBaseUrl/3.6.0"],
  ["/v3/registration/", "RegistrationsBaseUrl/3.0.0-rc"],
  ["/v3/search", "SearchQueryService/3.5.0"],
  ["/v3/search", "SearchQueryService/3.4.0"],
  ["/v3/search", "SearchQueryService/3.0.0-beta"],
  ["/v3/search", "SearchQueryService/3.0.0-rc"],
  ["/v3/autocomplete", "SearchAutocompleteService/3.5.0"],
  ["/v3/autocomplete", "SearchAutocompleteService/3.0.0-rc"],
  ["/v3/autocomplete", "SearchAutocompleteService/3.0.0-beta"],
  ["/api/v2/package", "PackagePublish/2.0.0"],
] as const;

export function serviceIndex(origin: string) {
  return {
    version: "3.0.0",
    resources: resources.map(([path, type]) => ({ "@id": `${origin}${path}`, "@type": type })),
  };
}

export function registrationUrl(id: string, origin: string, version?: string): string {
  const leaf = version === undefined ? "index" : normalizeNugetVersion(version);
  return `${origin}/v3/registration/${normalizeNugetId(id)}/${leaf}.json`;
}

export async function searchItem(pkg: Pick<NugetPackage, "name"> & { Release: CatalogRelease[] }, origin: string) {
  const releases = sortNugetReleases(pkg.Release);
  let metadata;
  while (releases.length) {
    metadata = await catalogMetadata(pkg, releases[0]);
    if (metadata) break;
    releases.shift();
  }
  if (!metadata) return null;
  const latest = releases[0];
  const name = normalizeNugetId(pkg.name);
  const version = normalizeNugetVersion(latest.version);

  return {
    "@id": registrationUrl(name, origin),
    id: pkg.name,
    version,
    title: metadata.title,
    description: metadata.description,
    summary: metadata.summary,
    authors: metadata.authors.split(/[,;]/u).map((author) => author.trim()),
    tags: metadata.tags,
    projectUrl: metadata.projectUrl,
    licenseUrl: metadata.licenseUrl,
    iconUrl: metadata.icon ? `${origin}/v3/package/${name}/${version}/icon` : metadata.iconUrl,
    totalDownloads: releases.reduce((sum, release) => sum + Number(release.downloads), 0),
    verified: false,
    versions: releases.reverse().map((release) => ({
      version: normalizeNugetVersion(release.version),
      downloads: Number(release.downloads),
      "@id": registrationUrl(name, origin, release.version),
    })),
  };
}

export async function registrationItem(pkg: Pick<NugetPackage, "name">, release: CatalogRelease, origin: string) {
  const version = normalizeNugetVersion(release.version);
  const metadata = await catalogMetadata(pkg, release);
  if (!metadata) return null;
  const packageContent = nugetPackageUrl(pkg.name, version, origin);
  const url = registrationUrl(pkg.name, origin, version);

  return {
    "@id": url,
    packageContent,
    catalogEntry: {
      "@id": `${url}#catalog`,
      id: pkg.name,
      version,
      listed: release.nugetListed,
      published: release.createdAt.toISOString(),
      packageContent,
      title: metadata.title,
      description: metadata.description,
      summary: metadata.summary,
      authors: metadata.authors,
      tags: metadata.tags,
      projectUrl: metadata.projectUrl,
      licenseUrl: metadata.licenseUrl,
      requireLicenseAcceptance: metadata.requireLicenseAcceptance,
      dependencyGroups: metadata.dependencyGroups.map((group) => ({
        ...(group.targetFramework ? { targetFramework: group.targetFramework } : {}),
        dependencies: group.dependencies.map((dependency) => ({
          id: dependency.id,
          range: dependency.range,
          registration: registrationUrl(dependency.id, origin),
        })),
      })),
    },
  };
}
