import { mkdirSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "../../apps/web/node_modules/react-dom/server";
import Page from "../../apps/web/src/app/[lang]/(main)/packages/[name]/page";
import { DevelopmentPackages } from "../../apps/web/src/app/[lang]/(store)/store/development-packages";
import { parseNuspec } from "../../packages/api/src/nuget/archive";

vi.mock("@beutl/api/nuget/catalog", async (original) => {
  const actual = await original<typeof import("@beutl/api/nuget/catalog")>();
  return { ...actual, findNugetPackage: vi.fn(async () => ({ name: "Sample.Library", Release: [release] })),
    searchNugetPackages: vi.fn(async () => ({ packages: [{ id: "pkg", name: "Sample.Library", Release: [release] }], totalHits: 1 })),
    catalogMetadata: vi.fn(async () => parseNuspec(manifest)),
    releaseMetadata: vi.fn(async () => ({ metadata: parseNuspec(manifest), readme: null })) };
});
const manifest = `<package><metadata><id>Sample.Library</id><version>1.0.0</version><title>Sample SDK</title>
  <authors>Example</authors><description>A sample SDK package.</description><tags>sdk</tags></metadata></package>`;
const release = { id: "release", version: "1.0.0", nugetListed: true, createdAt: new Date("2026-10-01"), downloads: 10n };

afterEach(() => vi.unstubAllEnvs());

describe("SDK package installation links", () => {
  it.each(["ja", "en"])("uses the runtime registry origin for %s snippets and downloads", async (lang) => {
    vi.stubEnv("NUGET_PUBLIC_ORIGIN", "https://staging.nuget.example/");
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ lang, name: "Sample.Library" }), searchParams: Promise.resolve({}) }));
    expect(html.match(/https:\/\/staging.nuget.example\/v3\/index.json/gu)).toHaveLength(2);
    expect(html).toContain('href="https://staging.nuget.example/v3/package/sample.library/1.0.0/sample.library.1.0.0.nupkg"');
    expect(html).not.toContain("nuget.beditor.net");
    const store = renderToStaticMarkup(await DevelopmentPackages({ lang }));
    expect(store).toContain("https://staging.nuget.example/v3/index.json");
    expect(store).not.toContain("nuget.beditor.net");
    const directory = process.env.BEUTL_NUGET_PREVIEW;
    if (directory) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(`${directory}/package-${lang}.html`, `<!doctype html><html lang="${lang}" class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body class="bg-background text-foreground">${html}</body></html>`);
      writeFileSync(`${directory}/store-${lang}.html`, `<!doctype html><html lang="${lang}" class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body class="bg-background text-foreground"><main class="max-w-6xl mx-auto px-4 py-10">${store}</main></body></html>`);
    }
  });
  it("defaults to the public registry when no origin is configured", async () => {
    vi.stubEnv("NUGET_PUBLIC_ORIGIN", "");
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ lang: "en", name: "Sample.Library" }), searchParams: Promise.resolve({}) }));
    expect(html).toContain("https://nuget.beditor.net/v3/index.json");
    expect(html).toContain('href="https://nuget.beditor.net/v3/package/sample.library/1.0.0/sample.library.1.0.0.nupkg"');
  });
});
