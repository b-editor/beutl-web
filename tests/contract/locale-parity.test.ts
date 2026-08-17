import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

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

const localesUrl = new URL("../../packages/i18n/src/locales/", import.meta.url);
const LOCALES = ["ja", "en"] as const;

async function readNamespace(locale: string, namespace: string) {
  const url = new URL(`${locale}/${namespace}`, localesUrl);
  return JSON.parse(await readFile(url, "utf8")) as unknown;
}

const namespaces = (await readdir(new URL("ja/", localesUrl))).filter((name) =>
  name.endsWith(".json"),
);

describe("translations", () => {
  it("ships the same namespaces in every locale", async () => {
    for (const locale of LOCALES) {
      const found = (await readdir(new URL(`${locale}/`, localesUrl)))
        .filter((name) => name.endsWith(".json"))
        .sort();
      expect(found, `${locale} namespaces`).toEqual([...namespaces].sort());
    }
  });

  it.each(namespaces)("defines the same keys in every locale: %s", async (namespace) => {
    const keysOf = (resource: unknown) =>
      flattenEntries(resource)
        .map(([key]) => key)
        .sort();
    const [ja, en] = await Promise.all([
      readNamespace("ja", namespace),
      readNamespace("en", namespace),
    ]);
    expect(keysOf(ja)).toEqual(keysOf(en));
  });

  it.each(namespaces)("leaves no empty translation behind: %s", async (namespace) => {
    for (const locale of LOCALES) {
      const empty = flattenEntries(await readNamespace(locale, namespace))
        .filter(
          ([, value]) => typeof value !== "string" || value.trim().length === 0,
        )
        .map(([key]) => key);
      expect(empty, `${locale}/${namespace} has empty translations`).toEqual([]);
    }
  });
});
