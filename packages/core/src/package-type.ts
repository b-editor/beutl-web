// A package's kind is carried by reserved entries in `Package.tags` rather than a
// column of its own, so the store, the desktop API and the developer portal all have
// to agree on the same two strings and the same "neither tag means extension" rule.
//
// The tags are prefixed because the desktop client reads the same vocabulary out of a
// package's nuspec, where a bare "material" is an ordinary tag plenty of unrelated
// packages already carry.

export const PACKAGE_TYPES = ["extension", "material", "template"] as const;
export type PackageType = (typeof PACKAGE_TYPES)[number];

export const PACKAGE_TYPE_FILTERS = ["all", ...PACKAGE_TYPES] as const;
export type PackageTypeFilter = (typeof PACKAGE_TYPE_FILTERS)[number];

export const MATERIAL_TAG = "beutl-material";
export const TEMPLATE_TAG = "beutl-template";

export const RESERVED_PACKAGE_TAGS = [MATERIAL_TAG, TEMPLATE_TAG] as const;
export type ReservedPackageTag = (typeof RESERVED_PACKAGE_TAGS)[number];

export function isReservedPackageTag(tag: string): tag is ReservedPackageTag {
  return (RESERVED_PACKAGE_TAGS as readonly string[]).includes(tag);
}

function tagFor(type: Exclude<PackageType, "extension">): ReservedPackageTag {
  return type === "material" ? MATERIAL_TAG : TEMPLATE_TAG;
}

export function isPackageType(value: unknown): value is PackageType {
  return (
    typeof value === "string" && (PACKAGE_TYPES as readonly string[]).includes(value)
  );
}

export function isPackageTypeFilter(value: unknown): value is PackageTypeFilter {
  return (
    typeof value === "string" &&
    (PACKAGE_TYPE_FILTERS as readonly string[]).includes(value)
  );
}

export function getPackageType(
  tags: readonly string[] | null | undefined,
): PackageType {
  if (!tags) return "extension";
  if (tags.includes(MATERIAL_TAG)) return "material";
  if (tags.includes(TEMPLATE_TAG)) return "template";
  return "extension";
}

/** The tags a package author actually chose, with the kind markers taken out. */
export function visiblePackageTags(
  tags: readonly string[] | null | undefined,
): string[] {
  return (tags ?? []).filter((tag) => !isReservedPackageTag(tag));
}

/** Replaces whichever kind marker a package carries with the one for `type`. */
export function applyPackageType(
  tags: readonly string[] | null | undefined,
  type: PackageType,
): string[] {
  const rest = visiblePackageTags(tags);
  return type === "extension" ? rest : [tagFor(type), ...rest];
}

/*
  Prisma has no `hasNone`, and its documented substitute — `NOT: { tags: { hasSome } }` —
  drops rows whose array column is SQL NULL. The `default_empty_package_tags` migration
  backfills those rows and gives the column a `[]` default so this predicate stays total.
*/
export function packageTypeWhere(type: PackageTypeFilter | undefined): {
  tags?: { has: ReservedPackageTag };
  NOT?: { tags: { has: ReservedPackageTag } | { hasSome: string[] } };
} {
  if (!type || type === "all") return {};
  if (type === "extension") {
    return { NOT: { tags: { hasSome: [...RESERVED_PACKAGE_TAGS] } } };
  }
  if (type === "template") {
    // A package carrying both markers resolves to material, so the template listing
    // has to exclude it or it would appear in both.
    return { tags: { has: TEMPLATE_TAG }, NOT: { tags: { has: MATERIAL_TAG } } };
  }
  return { tags: { has: tagFor(type) } };
}
