import { compareNugetVersions, isValidNugetVersion } from "@beutl/core";

function rangeBound(value: string): string | null {
  // NuGet allows whitespace around numeric components, but neither a v prefix
  // nor leading zeroes in numeric prerelease labels in dependency bounds.
  const match = /^(\d+(?:\s*\.\s*\d+){0,3})\s*(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(value.trim());
  if (!match || match[2]?.split(".").some((label) => /^0\d+$/u.test(label))) return null;
  const version = value.replace(/\s/gu, "");
  return isValidNugetVersion(version) ? version : null;
}

/** Validate nuspec dependency intervals; floating versions are project-only.
 * Equal exclusive bounds denote an empty range; mixed inclusivity is invalid. */
export function isValidNugetDependencyRange(value: string): boolean {
  if (value.length > 256 || value.includes("*")) return false;
  const range = value.trim();
  if (!range) return false;
  if (!range.startsWith("[") && !range.startsWith("(")) return rangeBound(range) !== null;
  if (!range.endsWith("]") && !range.endsWith(")")) return false;

  const parts = range.slice(1, -1).split(",");
  const minInclusive = range.startsWith("["), maxInclusive = range.endsWith("]");
  // Match NuGet.Versioning's raw empty-bound check: it rejects "(,)" but
  // accepts "(, )". Trimming before this check would admit client-invalid ranges.
  if (parts.length > 2 || parts.every((part) => part === "") || (parts.length === 1 && !(minInclusive && maxInclusive))) return false;
  const minText = parts[0], maxText = parts[1] ?? minText;
  const min = minText.trim() ? rangeBound(minText) : null;
  const max = maxText.trim() ? rangeBound(maxText) : null;
  if ((minText.trim() && !min) || (maxText.trim() && !max)) return false;
  if (min && max) {
    const order = compareNugetVersions(min, max);
    if (order > 0 || (order === 0 && minInclusive !== maxInclusive)) return false;
  }
  return true;
}
