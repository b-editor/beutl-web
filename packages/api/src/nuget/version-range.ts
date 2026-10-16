import { compareNugetVersions, isValidNugetVersion } from "@beutl/core";

function rangeBound(value: string, floating: boolean): string | null {
  if (floating && value.includes("*")) {
    if (!value.endsWith("*") || value.includes("+")) return null;
    const star = value.indexOf("*"), dash = value.indexOf("-");
    if (star !== value.length - 1) {
      if (star !== dash - 1) return null;
      const prefix = value.slice(dash + 1, -1);
      value = `${value.slice(0, star)}0-${prefix}${!prefix || prefix.endsWith(".") ? "0" : ""}`;
    } else {
      value = value.slice(0, -1);
      if (dash < 0 || (dash === value.lastIndexOf("-") && (value.endsWith("-") || value.endsWith(".")))) value += "0";
    }
  }
  // NuGet allows whitespace around numeric components, but neither a v prefix
  // nor leading zeroes in numeric prerelease labels in dependency bounds.
  const match = /^(\d+(?:\s*\.\s*\d+){0,3})\s*(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(value.trim());
  if (!match || match[2]?.split(".").some((label) => /^0\d+$/u.test(label))) return null;
  const version = value.replace(/\s/gu, "");
  return isValidNugetVersion(version) ? version : null;
}

/** Validate NuGet.Versioning's interval syntax, including floating lower bounds.
 * Equal exclusive bounds denote an empty range; mixed inclusivity is invalid. */
export function isValidNugetDependencyRange(value: string): boolean {
  if (value.length > 256) return false;
  const range = value.trim();
  if (!range) return false;
  if (!range.startsWith("[") && !range.startsWith("(")) return rangeBound(range, true) !== null;
  if (!range.endsWith("]") && !range.endsWith(")")) return false;

  const parts = range.slice(1, -1).split(",");
  const minInclusive = range.startsWith("["), maxInclusive = range.endsWith("]");
  if (parts.length > 2 || parts.every((part) => part === "") || (parts.length === 1 && !(minInclusive && maxInclusive))) return false;
  const minText = parts[0], maxText = parts[1] ?? minText;
  const min = minText.trim() ? rangeBound(minText, true) : null;
  const max = maxText.trim() ? rangeBound(maxText, false) : null;
  if ((minText.trim() && !min) || (maxText.trim() && !max)) return false;
  if (min && max) {
    const order = compareNugetVersions(min, max);
    if (order > 0 || (order === 0 && minInclusive !== maxInclusive)) return false;
  }
  return true;
}
