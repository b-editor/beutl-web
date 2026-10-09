/*
  The desktop builds the landing page offers. The rows come from
  AppReleaseAsset, which the release workflow fills and the in-app updater
  reads, so a download here is the same file the updater would install.

  This module stays free of server imports: the download button picks its file
  in the browser, after it has had a look at the visitor's machine.
*/

export const APP_DOWNLOAD_OSES = ["win", "osx", "linux"] as const;
export type AppDownloadOs = (typeof APP_DOWNLOAD_OSES)[number];

const APP_DOWNLOAD_ARCHES = ["x64", "arm64"] as const;
export type AppDownloadArch = (typeof APP_DOWNLOAD_ARCHES)[number];

const APP_DOWNLOAD_TYPES = ["installer", "app", "flatpak", "debian", "zip"] as const;
export type AppDownloadType = (typeof APP_DOWNLOAD_TYPES)[number];

export type AppDownload = {
  os: AppDownloadOs;
  arch: AppDownloadArch;
  type: AppDownloadType;
  standalone: boolean;
  url: string;
};

/**
 * `arch: null` means the visitor's architecture is unknown; `"other"` means it
 * is known to be one no build is made for, such as a 32-bit system.
 */
export type DetectedPlatform = {
  os: AppDownloadOs | null;
  arch: AppDownloadArch | "other" | null;
};

export const UNKNOWN_PLATFORM: DetectedPlatform = { os: null, arch: null };

/*
  The variants the page lists, in order. Only self-contained builds are listed,
  which run without a separately installed .NET runtime; the builds that need
  one remain on the GitHub releases page. Each platform's first variant is the
  one the download button offers. On Linux that is the Flatpak, the format most
  Linux downloads have chosen since it was introduced.
*/
const VARIANTS: { os: AppDownloadOs; type: AppDownloadType; standalone: boolean }[] = [
  { os: "win", type: "installer", standalone: true },
  { os: "osx", type: "app", standalone: true },
  { os: "linux", type: "flatpak", standalone: true },
  { os: "linux", type: "debian", standalone: true },
  { os: "linux", type: "zip", standalone: true },
];

/** Each platform's more common build, listed before the other. */
const LISTED_FIRST: Record<AppDownloadOs, AppDownloadArch> = {
  win: "x64",
  osx: "arm64",
  linux: "x64",
};

/*
  The architecture to assume when it cannot be detected. None is assumed for a
  Mac: its user agent names an Intel CPU on Apple silicon too, and neither build
  runs on the other's hardware, so an undetected Mac is shown the list.
*/
const ASSUMED_ARCH: Partial<Record<AppDownloadOs, AppDownloadArch>> = {
  win: "x64",
  linux: "x64",
};

function isOneOf<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

function variantIndex(download: AppDownload): number {
  return VARIANTS.findIndex(
    (variant) =>
      variant.os === download.os &&
      variant.type === download.type &&
      variant.standalone === download.standalone,
  );
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    // An unparsable URL is not one to link to; the row is skipped, not reported.
    return false;
  }
}

/**
 * Keeps the registered assets the page knows how to present, one per variant
 * and architecture, in listing order. The URLs end up in hrefs, so anything but
 * https is dropped.
 */
export function toAppDownloads(
  rows: { os: string; arch: string; type: string; standalone: boolean; url: string }[],
): AppDownload[] {
  const downloads: AppDownload[] = [];
  const seen = new Set<string>();
  for (const { os, arch, type, standalone, url } of rows) {
    if (
      !isOneOf(APP_DOWNLOAD_OSES, os) ||
      !isOneOf(APP_DOWNLOAD_ARCHES, arch) ||
      !isOneOf(APP_DOWNLOAD_TYPES, type) ||
      !isHttpsUrl(url)
    ) {
      continue;
    }
    const download = { os, arch, type, standalone, url };
    const key = `${os}/${arch}/${type}/${standalone}`;
    if (variantIndex(download) !== -1 && !seen.has(key)) {
      seen.add(key);
      downloads.push(download);
    }
  }

  const archRank = (download: AppDownload) =>
    download.arch === LISTED_FIRST[download.os] ? 0 : 1;
  return downloads.sort(
    (a, b) => variantIndex(a) - variantIndex(b) || archRank(a) - archRank(b),
  );
}

/** The file the download button offers on this platform, if one was released for it. */
export function pickPrimaryDownload<T extends AppDownload>(
  downloads: T[],
  platform: DetectedPlatform,
): T | null {
  const { os } = platform;
  if (os === null) {
    return null;
  }
  const arch = platform.arch ?? ASSUMED_ARCH[os];
  if (arch === undefined || arch === "other") {
    return null;
  }
  const primary = VARIANTS.find((variant) => variant.os === os)!;
  return (
    downloads.find(
      (download) =>
        download.os === os &&
        download.arch === arch &&
        download.type === primary.type &&
        download.standalone === primary.standalone,
    ) ?? null
  );
}

// Phones, tablets and Chromebooks get the full list rather than a desktop file.
const NON_DESKTOP_AGENT = /android|iphone|ipad|ipod|mobile|cros/i;
const NON_DESKTOP_PLATFORMS = new Set(["android", "ios", "chrome os", "chromium os"]);

function osFromPlatformName(name: string): AppDownloadOs | null {
  switch (name) {
    case "windows":
      return "win";
    case "macos":
      return "osx";
    case "linux":
      return "linux";
    default:
      return null;
  }
}

/**
 * Reads the visitor's platform from a user agent and, when the browser sends
 * one, the Sec-CH-UA-Platform hint (or navigator.userAgentData.platform).
 */
export function detectPlatform(
  userAgent: string | null | undefined,
  platformHint?: string | null,
): DetectedPlatform {
  const agent = userAgent ?? "";
  const hint = platformHint?.replaceAll('"', "").trim().toLowerCase() ?? "";
  if (NON_DESKTOP_AGENT.test(agent) || NON_DESKTOP_PLATFORMS.has(hint)) {
    return UNKNOWN_PLATFORM;
  }

  const os =
    osFromPlatformName(hint) ??
    (/windows nt/i.test(agent)
      ? "win"
      : /macintosh|mac os x/i.test(agent)
        ? "osx"
        : /linux|x11/i.test(agent)
          ? "linux"
          : null);
  if (os === null) {
    return UNKNOWN_PLATFORM;
  }
  // A Mac's user agent names an Intel CPU on Apple silicon too.
  if (os === "osx") {
    return { os, arch: null };
  }
  if (/arm64|aarch64/i.test(agent)) {
    return { os, arch: "arm64" };
  }
  // Firefox on Linux names the real CPU, including 32-bit ones.
  return { os, arch: /i[3-6]86|armv[67]/i.test(agent) ? "other" : null };
}

type HighEntropyValues = { architecture?: string; bitness?: string };

/** The parts of `navigator` that refinePlatform reads; userAgentData is Chromium only. */
export type NavigatorLike = {
  userAgent: string;
  maxTouchPoints?: number;
  userAgentData?: {
    platform?: string;
    getHighEntropyValues?(hints: string[]): Promise<HighEntropyValues>;
  };
};

function archFromClientHints({
  architecture,
  bitness,
}: HighEntropyValues): DetectedPlatform["arch"] {
  // Every build is 64-bit, so a 32-bit system has none to run.
  if (bitness && bitness !== "64") {
    return "other";
  }
  return architecture === "arm" ? "arm64" : architecture === "x86" ? "x64" : null;
}

/**
 * What the browser can tell beyond the request headers: an iPad asking for the
 * desktop site, and the CPU architecture through User-Agent Client Hints.
 */
export async function refinePlatform(navigator: NavigatorLike): Promise<DetectedPlatform> {
  const detected = detectPlatform(navigator.userAgent, navigator.userAgentData?.platform);
  // iPadOS requests desktop sites with a Mac user agent; only touch support tells them apart.
  if (detected.os === "osx" && (navigator.maxTouchPoints ?? 0) > 1) {
    return UNKNOWN_PLATFORM;
  }
  const getHighEntropyValues = navigator.userAgentData?.getHighEntropyValues;
  if (detected.os === null || !getHighEntropyValues) {
    return detected;
  }
  try {
    const values = await getHighEntropyValues.call(navigator.userAgentData, [
      "architecture",
      "bitness",
    ]);
    return { os: detected.os, arch: archFromClientHints(values) ?? detected.arch };
  } catch {
    // The hints only sharpen the guess; without them the user agent's answer stands.
    return detected;
  }
}
