import { Download } from "lucide-react";
import type { Translator } from "@beutl/i18n";
import { cn } from "@beutl/core";
import type { AppDownload } from "@/lib/app-download";
import { LP_BUTTON_PRIMARY, LP_CTA_ROW, LP_SECTION, LP_WRAP } from "./lp-parts";
import { PLATFORMS } from "./platform-logos";

export const DOWNLOAD_SECTION_ID = "download";

const ARCH_NAMES = { x64: "x64", arm64: "ARM64" } as const;

/** The card already names the platform, so a label only tells its files apart. */
function downloadLabel(download: AppDownload, t: Translator): string {
  switch (download.type) {
    case "installer":
      return t("main:downloadInstaller", { arch: ARCH_NAMES[download.arch] });
    case "app":
      return t(download.arch === "arm64" ? "main:downloadAppleSilicon" : "main:downloadIntelMac");
    case "flatpak":
      return t("main:downloadFlatpak");
    case "debian":
      return t("main:downloadDebian");
    case "zip":
      return t("main:downloadZip");
  }
}

/**
 * Every listed file by platform, or, when no release is registered, a link to
 * the GitHub releases page as the section offered before it listed files.
 */
export default function DownloadSection({
  t,
  version,
  downloads,
  releasesHref,
}: {
  t: Translator;
  version: string | null;
  downloads: AppDownload[];
  releasesHref: string;
}) {
  return (
    <section
      id={DOWNLOAD_SECTION_ID}
      className={cn(LP_SECTION, "scroll-mt-20 md:scroll-mt-36")}
    >
      <div className={LP_WRAP}>
        <h2 className="text-2xl font-semibold tracking-tight">
          {t("main:finalHeadline")}
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-lp-muted">
          {t("main:finalText")}
        </p>

        {version && downloads.length > 0 ? (
          <>
            <div className="mt-8 grid items-start gap-3 md:grid-cols-3">
              {PLATFORMS.map(({ os, nameKey, brand, Logo }) => {
                const files = downloads.filter((download) => download.os === os);
                if (files.length === 0) {
                  return null;
                }
                return (
                  <div
                    key={os}
                    className="min-w-0 rounded-lg border border-lp-border bg-lp-bg2 p-3"
                  >
                    <h3 className="flex items-center gap-2.5 px-3 pt-2 pb-1 text-sm font-semibold">
                      <span style={{ color: brand }}>
                        <Logo className="size-5" />
                      </span>
                      {t(`main:${nameKey}`)}
                    </h3>
                    <ul className="mt-1 flex flex-col">
                      {files.map((file) => (
                        <li key={`${file.type}-${file.arch}`}>
                          <a
                            href={file.url}
                            className="flex items-center gap-3 rounded-md px-3 py-2.5 text-sm text-lp-muted transition-colors outline-none hover:bg-white/[0.06] hover:text-lp-text focus-visible:ring-[3px] focus-visible:ring-ring/50"
                          >
                            <Download aria-hidden="true" className="size-4 shrink-0" />
                            <span className="min-w-0 [overflow-wrap:anywhere]">
                              {downloadLabel(file, t)}
                            </span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
            <p className="mt-4 text-xs leading-relaxed text-lp-muted">
              v{version}
              {" · "}
              <a
                href={`${releasesHref}/tag/v${version}`}
                className="whitespace-nowrap underline underline-offset-4 hover:text-lp-text"
              >
                {t("main:releaseNotes")}
              </a>
              {" · "}
              <a
                href={releasesHref}
                className="whitespace-nowrap underline underline-offset-4 hover:text-lp-text"
              >
                {t("main:moreDownloads")}
              </a>
            </p>
          </>
        ) : (
          <div className={LP_CTA_ROW}>
            <a href={`${releasesHref}/latest`} className={LP_BUTTON_PRIMARY}>
              <Download aria-hidden="true" />
              {t("main:download")}
            </a>
          </div>
        )}
      </div>
    </section>
  );
}
