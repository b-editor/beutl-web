import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Every `dashboard:ai.*` key the AI screens ask for has to exist, in both
// locales. i18next answers a missing key with the key itself, so the mistake
// does not throw or fail a build — it ships, and the screen shows
// "ai.videoQueuedDescription" where a sentence belongs. That is exactly how
// this one was found: by eye, after release.
const SCREEN_DIR = join(
  process.cwd(),
  "apps/web/src/app/[lang]/(dashboard)/dashboard/ai",
);

function aiKeysUsedIn(source: string): string[] {
  // t("dashboard:ai.foo") and t(`dashboard:ai.foo.${bar}`). The templated form
  // is checked as far as its fixed prefix: the group has to exist even when
  // which member is read is decided at runtime.
  const keys = new Set<string>();
  for (const match of source.matchAll(
    /["'`]dashboard:ai\.([A-Za-z0-9_.]*)/g,
  )) {
    const key = match[1]!.replace(/\.$/, "");
    if (key) keys.add(key);
  }
  return [...keys];
}

function readLocale(lang: string): Record<string, unknown> {
  const path = join(
    process.cwd(),
    `packages/i18n/src/locales/${lang}/dashboard.json`,
  );
  return (JSON.parse(readFileSync(path, "utf8")) as { ai: Record<string, unknown> }).ai;
}

function resolves(ai: Record<string, unknown>, key: string): boolean {
  // A flat key containing dots is how the operation names are stored, so both
  // spellings count as present.
  if (Object.hasOwn(ai, key)) return true;
  let current: unknown = ai;
  for (const part of key.split(".")) {
    if (typeof current !== "object" || current === null) return false;
    if (!Object.hasOwn(current as object, part)) return false;
    current = (current as Record<string, unknown>)[part];
  }
  return current !== undefined;
}

describe("dashboard AI translation keys", () => {
  // Recursively: every screen is a `page.tsx` in its own folder, so a scan of
  // the direct children reads the forms and none of the pages that mount them.
  // The page is where a screen's heading and description are read, which is
  // exactly the kind of key this test exists to catch.
  const sources = readdirSync(SCREEN_DIR, {
    withFileTypes: true,
    recursive: true,
  })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => {
      const full = join(entry.parentPath ?? SCREEN_DIR, entry.name);
      return { name: relative(SCREEN_DIR, full), keys: aiKeysUsedIn(readFileSync(full, "utf8")) };
    })
    .filter((entry) => entry.keys.length > 0);

  it("reads at least the screens this test exists for", () => {
    // A directory move must not turn this into a test that checks nothing.
    const names = sources.map((entry) => entry.name);
    expect(names).toContain("video-edit-form.tsx");
    // A page in a subfolder, which a non-recursive scan would miss. Named
    // rather than counted: the count was already above its floor while every
    // page was being skipped.
    expect(names).toContain(join("video-edit", "page.tsx"));
    expect(sources.length).toBeGreaterThan(3);
  });

  for (const lang of ["ja", "en"] as const) {
    it(`resolves every key in ${lang}`, () => {
      const ai = readLocale(lang);
      const missing = sources.flatMap((entry) =>
        entry.keys
          .filter((key) => !resolves(ai, key))
          .map((key) => `${entry.name}: ai.${key}`),
      );

      expect(missing).toEqual([]);
    });
  }
});
