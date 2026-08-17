import { describe, expect, it } from "vitest";
import en from "../../packages/i18n/src/locales/en/admin.json";
import ja from "../../packages/i18n/src/locales/ja/admin.json";

// A key present in only one locale renders as the raw key for that language,
// which is easy to miss when a screen is only ever checked in one locale.
// Key segments can themselves contain dots (operation names), so entries are
// collected as pairs rather than reconstructed from a joined path.
function flattenEntries(value: unknown, prefix = ""): [string, unknown][] {
  if (typeof value !== "object" || value === null) {
    return [[prefix, value]];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    flattenEntries(child, prefix === "" ? key : `${prefix}.${key}`),
  );
}

describe("admin translations", () => {
  it("defines the same keys in every locale", () => {
    const keysOf = (resource: unknown) =>
      flattenEntries(resource)
        .map(([key]) => key)
        .sort();
    expect(keysOf(ja)).toEqual(keysOf(en));
  });

  it("leaves no empty translation behind", () => {
    for (const [locale, resource] of [
      ["ja", ja],
      ["en", en],
    ] as const) {
      const empty = flattenEntries(resource)
        .filter(
          ([, value]) => typeof value !== "string" || value.trim().length === 0,
        )
        .map(([key]) => key);
      expect(empty, `${locale} has empty translations`).toEqual([]);
    }
  });
});
