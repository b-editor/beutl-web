import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTranslation } from "@beutl/i18n";

const mocks = vi.hoisted(() => ({ retrieveDevPackageByName: vi.fn() }));

vi.mock("@/lib/auth-guard", () => ({
  authenticated: vi.fn(),
  throwIfUnauth: async () => ({ user: { id: "owner" } }),
}));
vi.mock("@beutl/db", async (original) => ({
  ...await original<object>(),
  retrieveDevPackageByName: mocks.retrieveDevPackageByName,
}));
vi.mock("@beutl/next/language", () => ({ getLanguage: async () => "en" }));
vi.mock("@beutl/next/audit-log", () => ({ addAuditLog: async () => {}, auditLogActions: { developer: {} } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/storage", () => ({ createDedicatedStorageFile: vi.fn() }));

import { toPackages } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/packages";
import { retrievePackage } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/actions/package";
import { PackageDownloads } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/package-downloads";
import type { Package } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/types";

const appRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { renderToStaticMarkup } = appRequire("react-dom/server");

const release = (id: string, version: string, downloads: bigint, published = true) => ({
  id, version, downloads, published, title: version, description: "", targetVersion: "1.0.0",
  artifactLocked: published, ReleaseTranslation: [], file: { name: `${id}.nupkg` },
});

describe("developer package downloads", () => {
  beforeEach(() => vi.clearAllMocks());

  it("totals every release of each package on the portal", () => {
    const row = (id: string, downloads: bigint[]) => ({
      id, audience: "USER" as const, name: id, displayName: null, published: true, iconFile: null,
      Release: downloads.map((count, index) => ({ version: `1.${index}.0`, downloads: count })),
    });

    const packages = toPackages([row("with-releases", [1200n, 34n, 0n]), row("draft", [])]);

    expect(packages.map(({ name, downloads }) => [name, downloads])).toEqual([["with-releases", 1234], ["draft", 0]]);
  });

  it("keeps counts out of the release editor and lists them newest first", async () => {
    mocks.retrieveDevPackageByName.mockResolvedValue({
      id: "pkg", name: "Package", iconFile: null, PackageScreenshot: [], PackageTranslation: [],
      Release: [release("old", "1.0.0", 7n), release("draft", "2.0.0-preview.1", 0n, false), release("new", "1.10.0", 42n)],
    });

    const pkg = await retrievePackage("Package");

    expect(mocks.retrieveDevPackageByName).toHaveBeenCalledWith({ name: "Package", userId: "owner" });
    expect(pkg?.Release.map((r) => r.version)).toEqual(["2.0.0-preview.1", "1.10.0", "1.0.0"]);
    expect(pkg?.Release.every((r) => !("downloads" in r))).toBe(true);
    expect(pkg?.releaseDownloads).toEqual([
      { id: "draft", version: "2.0.0-preview.1", published: false, downloads: 0 },
      { id: "new", version: "1.10.0", published: true, downloads: 42 },
      { id: "old", version: "1.0.0", published: true, downloads: 7 },
    ]);
  });

  it.each(["ja", "en"])("shows the total and each version's count (%s)", async (lang) => {
    const { t } = await getTranslation(lang);
    const pkg = {
      releaseDownloads: [
        { id: "new", version: "1.1.0", published: false, downloads: 1000 },
        { id: "old", version: "1.0.0", published: true, downloads: 234 },
      ],
    } as Package;

    const html: string = renderToStaticMarkup(await PackageDownloads({ pkg, lang }));

    expect(html).toContain(`>${(1234).toLocaleString(lang)}<`);
    expect(html).toContain(t("developer:downloads.since"));
    expect(html).toMatch(new RegExp(`1\\.1\\.0.*${t("developer:downloads.unpublished")}.*>${(1000).toLocaleString(lang)}<`));
    expect(html).toMatch(/1\.0\.0<\/dt><dd[^>]*>234</);
  });

  it("formats the portal summary with plural forms", async () => {
    const { t } = await getTranslation("en");

    expect(t("developer:downloads.count", { count: 1 })).toBe("1 download");
    expect(t("developer:downloads.count", { count: 1234 })).toBe("1,234 downloads");
  });
});
