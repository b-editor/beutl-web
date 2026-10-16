export type PackageAudience = "USER" | "DEVELOPMENT";

export const NUGET_ORIGIN = "https://nuget.beditor.net";
export const NUGET_SERVICE_INDEX = `${NUGET_ORIGIN}/v3/index.json`;

export class InvalidNugetIdentityError extends Error {}

export function normalizeNugetId(id: string): string {
  if (id.length > 100 || !/^\w+(?:[._-]\w+)*$/u.test(id)) {
    throw new InvalidNugetIdentityError("Invalid NuGet package ID");
  }
  return id.toLowerCase();
}

/** NuGet identity ignores build metadata, padded core numbers and a zero revision.
 * Also accept the v prefix stored by the previous Web release form. */
export function normalizeNugetVersion(version: string): string {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(version);
  if (!match || version.length > 128) throw new InvalidNugetIdentityError("Invalid NuGet version");
  if (match[5]?.split(".").some((label) => /^0\d+$/u.test(label))) throw new InvalidNugetIdentityError("Invalid NuGet version");
  const numbers = match.slice(1, 5).map((n) => Number(n ?? 0));
  if (numbers.some((n) => !Number.isSafeInteger(n) || n > 2147483647)) throw new InvalidNugetIdentityError("Invalid NuGet version");
  return numbers.slice(0, numbers[3] ? 4 : 3).join(".") + (match[5] ? `-${match[5].toLowerCase()}` : "");
}

export function fullNugetVersion(version: string): string {
  // NuGet's ToFullString normalizes core numbers but preserves the manifest's
  // prerelease spelling and build metadata. URLs still use identity versions.
  return normalizeNugetVersion(version).split("-")[0] + (version.match(/[-+].*$/u)?.[0] ?? "");
}

export function isValidNugetVersion(version: string): boolean {
  try { normalizeNugetVersion(version); return true; }
  catch (error) {
    if (error instanceof InvalidNugetIdentityError) return false;
    throw error;
  }
}

/** Older clients cannot read build metadata or dotted prerelease labels,
 * including when they occur in a dependency range's bounds. */
export function requiresNugetSemVer2(version: string, metadata?: NugetMetadata): boolean {
  const isSemVer2 = (value: string) => /\+|-[^+]*\./u.test(value);
  return isSemVer2(version) || !!metadata && (isSemVer2(metadata.version) ||
    metadata.dependencyGroups.some((group) => group.dependencies.some((dependency) =>
      dependency.range.split(/[,[\]()]/u).some(isSemVer2))));
}

export function compareNugetVersions(left: string, right: string): number {
  const a = normalizeNugetVersion(left).split("-");
  const b = normalizeNugetVersion(right).split("-");
  const an = a[0].split(".").map(Number), bn = b[0].split(".").map(Number);
  for (let i = 0; i < 4; i++) {
    const diff = (an[i] ?? 0) - (bn[i] ?? 0);
    if (diff) return diff;
  }
  const ap = a.slice(1).join("-"), bp = b.slice(1).join("-");
  if (!ap || !bp) return ap === bp ? 0 : ap ? -1 : 1;
  const ax = ap.split("."), bx = bp.split(".");
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    if (ax[i] === undefined || bx[i] === undefined) return ax[i] === undefined ? -1 : 1;
    if (ax[i] === bx[i]) continue;
    const numericA = /^\d+$/u.test(ax[i]), numericB = /^\d+$/u.test(bx[i]);
    if (numericA && numericB) {
      if (BigInt(ax[i]) === BigInt(bx[i])) continue;
      return BigInt(ax[i]) < BigInt(bx[i]) ? -1 : 1;
    }
    if (numericA !== numericB) return numericA ? -1 : 1;
    return ax[i] < bx[i] ? -1 : 1;
  }
  return 0;
}

export function nugetPackageUrl(id: string, version: string, origin = NUGET_ORIGIN): string {
  const name = normalizeNugetId(id), normalized = normalizeNugetVersion(version);
  return `${origin.replace(/\/$/u, "")}/v3/package/${name}/${normalized}/${name}.${normalized}.nupkg`;
}

export type NugetMetadata = {
  id: string;
  version: string;
  title: string;
  authors: string;
  description: string;
  summary: string;
  tags: string[];
  projectUrl: string;
  licenseUrl: string;
  license: string;
  licenseType?: "file" | "expression";
  releaseNotes: string;
  requireLicenseAcceptance: boolean;
  icon: string;
  iconUrl: string;
  readme: string;
  dependencyGroups: { targetFramework: string; dependencies: { id: string; range: string }[] }[];
  packageTypes: { name: string; version: string }[];
  repository: { type: string; url: string; branch: string; commit: string };
};
