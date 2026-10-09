"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Download } from "lucide-react";
import { cn } from "@beutl/core";
import {
  pickPrimaryDownload,
  refinePlatform,
  type AppDownload,
  type AppDownloadOs,
  type DetectedPlatform,
  type NavigatorLike,
} from "@/lib/app-download";
import { LP_BUTTON_PRIMARY, LP_CTA_ROW } from "./lp-parts";

export type DownloadCtaProps = {
  version: string | null;
  downloads: AppDownload[];
  /** Read from the request headers, so the first render already names the platform. */
  initialPlatform: DetectedPlatform;
  /** Where the button leads when no file fits the visitor's platform. */
  fallbackHref: string;
  /** Where the full list is, linked under the button when it offers a file. */
  otherDownloadsHref: string;
  texts: {
    download: string;
    downloadFor: Record<AppDownloadOs, string>;
    otherDownloads: string;
  };
};

/**
 * The download button with the version underneath. The request headers pick
 * the platform for the first render; the browser then refines it, which on
 * Chromium includes the CPU architecture.
 */
export default function DownloadCta({
  version,
  downloads,
  initialPlatform,
  fallbackHref,
  otherDownloadsHref,
  texts,
  className,
  children,
}: DownloadCtaProps & {
  className?: string;
  /** Further actions placed next to the download button. */
  children?: ReactNode;
}) {
  const [platform, setPlatform] = useState(initialPlatform);

  useEffect(() => {
    let cancelled = false;
    void refinePlatform(navigator as NavigatorLike).then((refined) => {
      if (!cancelled) {
        setPlatform(refined);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const primary = pickPrimaryDownload(downloads, platform);

  return (
    <div className={className}>
      <div className={cn(LP_CTA_ROW, "mt-0")}>
        <a href={primary?.url ?? fallbackHref} className={LP_BUTTON_PRIMARY}>
          <Download aria-hidden="true" />
          {primary ? texts.downloadFor[primary.os] : texts.download}
        </a>
        {children}
      </div>
      {version && (
        <p className="mt-3 text-xs leading-relaxed text-lp-muted">
          v{version}
          {primary && (
            <>
              {" · "}
              <a
                href={otherDownloadsHref}
                className="whitespace-nowrap underline underline-offset-4 hover:text-lp-text"
              >
                {texts.otherDownloads}
              </a>
            </>
          )}
        </p>
      )}
    </div>
  );
}
