import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  findAppReleaseAssetVersions: vi.fn(),
  findAppReleaseAssetsByVersion: vi.fn(),
}));

vi.mock("@beutl/db", () => db);
// The cache and the dedicated client are covered elsewhere; here they pass through.
vi.mock("next/cache", () => ({ unstable_cache: <T>(work: T) => work }));
vi.mock("@/prisma", () => ({
  withOwnPrismaClient: <T>(work: (prisma: unknown) => Promise<T>) => work("own-client"),
}));

import {
  detectPlatform,
  pickPrimaryDownload,
  refinePlatform,
  toAppDownloads,
  type AppDownload,
} from "../../apps/web/src/lib/app-download";
import { retrieveLatestAppReleaseForLanding } from "../../apps/web/src/lib/app-release";
import DownloadCta, { type DownloadCtaProps } from "../../apps/web/src/components/landing/download-cta";

const appRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { renderToStaticMarkup } = appRequire("react-dom/server");
const { createElement } = appRequire("react");

const AGENTS = {
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  windowsArm: "Mozilla/5.0 (Windows NT 10.0; ARM64; rv:143.0) Gecko/20100101 Firefox/143.0",
  windows32: "Mozilla/5.0 (Windows NT 10.0; rv:143.0) Gecko/20100101 Firefox/143.0",
  windowsWow64: "Mozilla/5.0 (Windows NT 10.0; WOW64; rv:143.0) Gecko/20100101 Firefox/143.0",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  linux: "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0",
  linuxArm: "Mozilla/5.0 (X11; Linux aarch64; rv:143.0) Gecko/20100101 Firefox/143.0",
  linux32: "Mozilla/5.0 (X11; Linux i686; rv:143.0) Gecko/20100101 Firefox/143.0",
  linuxArm32: "Mozilla/5.0 (X11; Linux armv7l; rv:143.0) Gecko/20100101 Firefox/143.0",
  android:
    "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  freebsd: "Mozilla/5.0 (X11; FreeBSD amd64; rv:143.0) Gecko/20100101 Firefox/143.0",
  chromebook:
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
};

const asset = (os: string, arch: string, type: string, standalone: boolean) => ({
  os,
  arch,
  type,
  standalone,
  url: `https://github.com/b-editor/beutl/releases/download/v2.0.0/${os}-${arch}-${type}-${standalone}`,
});

// What the release workflow registers for every version.
const REGISTERED = [
  asset("linux", "x64", "zip", false),
  asset("osx", "x64", "app", true),
  asset("win", "arm64", "installer", false),
  asset("linux", "x64", "debian", true),
  asset("win", "x64", "installer", false),
  asset("osx", "arm64", "app", true),
  asset("linux", "x64", "zip", true),
  asset("win", "arm64", "installer", true),
  asset("linux", "x64", "flatpak", true),
  asset("win", "x64", "installer", true),
];

const key = ({ os, arch, type, standalone }: AppDownload) =>
  `${os}/${arch}/${type}/${standalone ? "standalone" : "runtime"}`;

describe("platform detection", () => {
  it.each([
    ["windows", { os: "win", arch: "x64" }],
    ["windowsArm", { os: "win", arch: "arm64" }],
    // A 32-bit browser on 64-bit Windows can run the x64 build.
    ["windowsWow64", { os: "win", arch: "x64" }],
    ["windows32", { os: "win", arch: "other" }],
    // Safari names an Intel CPU on Apple silicon, so the architecture stays open.
    ["mac", { os: "osx", arch: null }],
    ["linux", { os: "linux", arch: "x64" }],
    ["linuxArm", { os: "linux", arch: "arm64" }],
    ["linux32", { os: "linux", arch: "other" }],
    ["linuxArm32", { os: "linux", arch: "other" }],
    ["android", { os: null, arch: null }],
    ["iphone", { os: null, arch: null }],
    ["chromebook", { os: null, arch: null }],
    ["freebsd", { os: null, arch: null }],
  ] as const)("reads %s from the user agent", (agent, expected) => {
    expect(detectPlatform(AGENTS[agent])).toEqual(expected);
  });

  it("prefers the Sec-CH-UA-Platform hint over the user agent", () => {
    expect(detectPlatform(AGENTS.windows, '"macOS"')).toEqual({ os: "osx", arch: null });
    expect(detectPlatform(AGENTS.windows, '"Android"')).toEqual({ os: null, arch: null });
  });

  it("knows nothing without a user agent", () => {
    expect(detectPlatform(null, null)).toEqual({ os: null, arch: null });
  });

  it("takes the architecture from User-Agent Client Hints", async () => {
    const getHighEntropyValues = vi.fn().mockResolvedValue({ architecture: "arm", bitness: "64" });
    await expect(
      refinePlatform({
        userAgent: AGENTS.mac,
        userAgentData: { platform: "macOS", getHighEntropyValues },
      }),
    ).resolves.toEqual({ os: "osx", arch: "arm64" });
    expect(getHighEntropyValues).toHaveBeenCalledWith(["architecture", "bitness"]);

    await expect(
      refinePlatform({
        userAgent: AGENTS.mac,
        userAgentData: {
          platform: "macOS",
          getHighEntropyValues: async () => ({ architecture: "x86", bitness: "64" }),
        },
      }),
    ).resolves.toEqual({ os: "osx", arch: "x64" });
  });

  it("marks a 32-bit system as one no build fits", async () => {
    await expect(
      refinePlatform({
        userAgent: AGENTS.windows,
        userAgentData: {
          platform: "Windows",
          getHighEntropyValues: async () => ({ architecture: "x86", bitness: "32" }),
        },
      }),
    ).resolves.toEqual({ os: "win", arch: "other" });
  });

  it("keeps the user agent's answer when the hints fail or are missing", async () => {
    await expect(
      refinePlatform({
        userAgent: AGENTS.windowsArm,
        userAgentData: { getHighEntropyValues: () => Promise.reject(new Error("denied")) },
      }),
    ).resolves.toEqual({ os: "win", arch: "arm64" });
    await expect(refinePlatform({ userAgent: AGENTS.linux })).resolves.toEqual({
      os: "linux",
      arch: "x64",
    });
  });

  it("treats an iPad asking for the desktop site as a tablet", async () => {
    await expect(refinePlatform({ userAgent: AGENTS.mac, maxTouchPoints: 5 })).resolves.toEqual({
      os: null,
      arch: null,
    });
    await expect(refinePlatform({ userAgent: AGENTS.mac, maxTouchPoints: 0 })).resolves.toEqual({
      os: "osx",
      arch: null,
    });
  });
});

describe("registered downloads", () => {
  it("lists the self-contained builds grouped by platform, defaults first", () => {
    // The builds that need a separately installed .NET runtime, and the .deb,
    // which the Flatpak supersedes, stay on GitHub.
    expect(toAppDownloads(REGISTERED).map(key)).toEqual([
      "win/x64/installer/standalone",
      "win/arm64/installer/standalone",
      "osx/arm64/app/standalone",
      "osx/x64/app/standalone",
      "linux/x64/flatpak/standalone",
      "linux/x64/zip/standalone",
    ]);
  });

  it("drops rows it cannot present and URLs that are not https", () => {
    const downloads = toAppDownloads([
      { ...asset("win", "x64", "installer", true), url: "javascript:alert(1)" },
      { ...asset("win", "x64", "installer", true), url: "http://example.test/setup.exe" },
      { ...asset("win", "x64", "installer", true), url: "not a url" },
      asset("win", "x86", "installer", true),
      asset("freebsd", "x64", "zip", true),
      asset("win", "x64", "msix", true),
      // No such variant is offered, so it would have nowhere to be listed.
      asset("osx", "arm64", "app", false),
      asset("linux", "x64", "flatpak", true),
      { ...asset("linux", "x64", "flatpak", true), url: "https://example.test/duplicate" },
    ]);
    expect(downloads).toEqual([asset("linux", "x64", "flatpak", true)]);
  });

  it.each([
    [{ os: "win", arch: "x64" }, "win/x64/installer/standalone"],
    [{ os: "win", arch: "arm64" }, "win/arm64/installer/standalone"],
    [{ os: "osx", arch: "arm64" }, "osx/arm64/app/standalone"],
    [{ os: "osx", arch: "x64" }, "osx/x64/app/standalone"],
    [{ os: "linux", arch: "x64" }, "linux/x64/flatpak/standalone"],
  ] as const)("offers the self-contained build for %o", (platform, expected) => {
    const primary = pickPrimaryDownload(toAppDownloads(REGISTERED), platform);
    expect(primary && key(primary)).toBe(expected);
  });

  it("offers nothing where no build fits", () => {
    const downloads = toAppDownloads(REGISTERED);
    expect(pickPrimaryDownload(downloads, { os: "linux", arch: "arm64" })).toBeNull();
    expect(pickPrimaryDownload(downloads, { os: "win", arch: "other" })).toBeNull();
    expect(pickPrimaryDownload(downloads, { os: "linux", arch: "other" })).toBeNull();
    expect(pickPrimaryDownload(downloads, { os: null, arch: null })).toBeNull();
  });

  it.each(["win", "osx", "linux"] as const)(
    "guesses no build for %s when the CPU is unknown",
    (os) => {
      // Every build runs on one architecture only.
      expect(pickPrimaryDownload(toAppDownloads(REGISTERED), { os, arch: null })).toBeNull();
    },
  );
});

describe("latest release for the landing page", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => vi.restoreAllMocks());

  it("picks the highest version by semver rather than by string order", async () => {
    db.findAppReleaseAssetVersions.mockResolvedValue(
      ["1.1.0", "2.0.0-preview.8", "2.0.0-preview.10", "2.0.0-preview.9", "not-a-version"]
        .flatMap((version) => [{ version }, { version }]),
    );
    db.findAppReleaseAssetsByVersion.mockResolvedValue(REGISTERED);

    const release = await retrieveLatestAppReleaseForLanding();

    expect(db.findAppReleaseAssetVersions).toHaveBeenCalledWith({ prisma: "own-client" });
    expect(db.findAppReleaseAssetsByVersion).toHaveBeenCalledExactlyOnceWith({
      version: "2.0.0-preview.10",
      prisma: "own-client",
    });
    expect(release).toEqual({
      version: "2.0.0-preview.10",
      downloads: toAppDownloads(REGISTERED),
    });
  });

  it("has nothing to offer before any release is registered", async () => {
    db.findAppReleaseAssetVersions.mockResolvedValue([]);
    await expect(retrieveLatestAppReleaseForLanding()).resolves.toBeNull();
    expect(db.findAppReleaseAssetsByVersion).not.toHaveBeenCalled();
  });

  it("falls back to the releases page when the catalog cannot be read", async () => {
    const error = new Error("connection refused");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    db.findAppReleaseAssetVersions.mockRejectedValue(error);

    await expect(retrieveLatestAppReleaseForLanding()).resolves.toBeNull();
    expect(log).toHaveBeenCalledWith(
      "[landing] could not load the app release; linking to GitHub instead:",
      error,
    );
  });

  it("recomputes the release on a client of its own", () => {
    const source = readFileSync(
      new URL("../../apps/web/src/lib/app-release.ts", import.meta.url),
      "utf8",
    );
    expect(source.slice(source.indexOf("unstable_cache("))).toMatch(
      /^unstable_cache\(\s*\(\) => withOwnPrismaClient\(\(prisma\) => findLatestAppRelease\(prisma\)\)/u,
    );
  });
});

describe("download button", () => {
  const props = (overrides: Partial<DownloadCtaProps>): DownloadCtaProps => ({
    version: "2.0.0",
    downloads: toAppDownloads(REGISTERED),
    initialPlatform: { os: null, arch: null },
    fallbackHref: "#download",
    otherDownloadsHref: "#download",
    texts: {
      download: "Download for free",
      downloadFor: { win: "Download for Windows", osx: "Download for macOS", linux: "Download for Linux" },
      otherDownloads: "Other platforms",
    },
    ...overrides,
  });
  const render = (overrides: Partial<DownloadCtaProps>) =>
    renderToStaticMarkup(createElement(DownloadCta, props(overrides)));

  it("links straight to the file for the platform read from the request", () => {
    const html = render({ initialPlatform: { os: "win", arch: "x64" } });

    expect(html).toContain(`href="${asset("win", "x64", "installer", true).url}"`);
    expect(html).toContain("Download for Windows");
    expect(html).toMatch(/v2\.0\.0 · <a href="#download"[^>]*>Other platforms<\/a>/u);
  });

  it.each([
    { os: "linux", arch: "arm64" },
    { os: "osx", arch: null },
  ] as const)("leads to the full list when no file is known to fit %o", (initialPlatform) => {
    const html = render({ initialPlatform });

    expect(html).toContain('href="#download"');
    expect(html).toContain("Download for free");
    expect(html).not.toContain("Other platforms");
  });

  it("keeps linking to GitHub when no release is registered", () => {
    const html = render({
      version: null,
      downloads: [],
      initialPlatform: { os: "win", arch: null },
      fallbackHref: "https://github.com/b-editor/beutl/releases/latest",
    });

    expect(html).toContain('href="https://github.com/b-editor/beutl/releases/latest"');
    expect(html).toContain("Download for free");
    expect(html).not.toMatch(/<p[\s>]/u);
  });
});
