import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const webSource = new URL("../../apps/web/src/", import.meta.url);

function linkOpenings(source: string): string[] {
  return source.match(/<Link\b[^>]*>/gs) ?? [];
}

function tsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [path] : [];
  });
}

describe("dashboard navigation prefetch", () => {
  it("does not fan out authenticated sidebar requests in the background", () => {
    const dashboardSidebar = readFileSync(
      new URL("components/dashboard/dashboard-sidebar.tsx", webSource),
      "utf8",
    );
    const links = linkOpenings(dashboardSidebar);

    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toContain("prefetch={false}");
    }
  });

  it("does not eagerly load links rendered by authenticated dashboard pages", () => {
    const dashboardRoot = new URL(
      "app/[lang]/(dashboard)/dashboard/",
      webSource,
    );
    const filesWithLinks = tsxFiles(dashboardRoot.pathname).filter((path) =>
      readFileSync(path, "utf8").includes('from "next/link"'),
    );

    expect(filesWithLinks.length).toBeGreaterThan(0);
    for (const path of filesWithLinks) {
      const links = linkOpenings(readFileSync(path, "utf8"));
      expect(links.length, path).toBeGreaterThan(0);
      for (const link of links) {
        expect(link, path).toContain("prefetch={false}");
      }
    }
  });
});
