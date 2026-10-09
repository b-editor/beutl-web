"use client";

import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  File as FileIcon,
  Loader2,
} from "lucide-react";
import { useEffect, useState, type KeyboardEvent } from "react";
import { Button } from "@beutl/ui/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@beutl/ui/ui/dialog";
import { cn, formatBytes, normalizeMimeType } from "@beutl/core";
import { useTranslation } from "@beutl/ui/i18n-client";
import { servedInline } from "@/lib/content-cache";
import { contentImageSources } from "@/lib/content-image";

/** A file the preview can show: where its bytes are served and what they are. */
export type PreviewFile = {
  key: string;
  name: string;
  url: string;
  mimeType: string;
  size: number;
};

// Text is read from the start of the file; past this the preview says it stops.
const MAX_TEXT_BYTES = 512 * 1024;
const TEXT_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-yaml",
  "application/yaml",
]);

type PreviewKind = "image" | "video" | "audio" | "text" | "none";

export function previewKind(mimeType: string): PreviewKind {
  const type = normalizeMimeType(mimeType);
  if (servedInline(type)) {
    if (type.startsWith("image/")) return "image";
    if (type.startsWith("video/")) return "video";
    if (type.startsWith("audio/")) return "audio";
  }
  if (type.startsWith("text/") || TEXT_TYPES.has(type)) return "text";
  return "none";
}

// Same-origin, so the download attribute overrides an inline disposition.
export function downloadPreviewFile(file: Pick<PreviewFile, "url" | "name">): void {
  const anchor = document.createElement("a");
  anchor.href = file.url;
  anchor.download = file.name;
  anchor.rel = "noreferrer";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

type TextState =
  | { status: "loading" }
  | { status: "loaded"; text: string; truncated: boolean }
  | { status: "binary" }
  | { status: "failed" };

function TextPreview({ file, lang }: { file: PreviewFile; lang: string }) {
  const { t } = useTranslation(lang);
  const [state, setState] = useState<TextState>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    // Any byte range of an empty file is unsatisfiable, so there is nothing to ask for.
    if (file.size === 0) {
      setState({ status: "loaded", text: "", truncated: false });
      return;
    }
    setState({ status: "loading" });
    (async () => {
      const response = await fetch(file.url, {
        headers: { Range: `bytes=0-${MAX_TEXT_BYTES - 1}` },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer()).subarray(0, MAX_TEXT_BYTES);
      // A NUL byte means the file is not text, whatever its name says.
      if (bytes.includes(0)) return setState({ status: "binary" });
      const truncated = file.size > bytes.byteLength;
      setState({
        status: "loaded",
        // Streaming holds back a character the cut split instead of showing U+FFFD.
        text: new TextDecoder().decode(bytes, { stream: truncated }),
        truncated,
      });
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      console.error("Loading the text preview failed", error);
      setState({ status: "failed" });
    });
    return () => controller.abort();
  }, [file.url, file.size]);

  if (state.status === "loading") {
    return <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-label={t("storage:previewLoading")} />;
  }
  if (state.status !== "loaded") {
    return <Unavailable file={file} lang={lang} reason={state.status === "failed" ? "failed" : "unsupported"} />;
  }
  return (
    <div className="flex h-full w-full flex-col gap-2">
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background p-4 font-mono text-xs leading-relaxed">
        {state.text}
      </pre>
      {state.truncated && (
        <p className="text-xs text-muted-foreground">
          {t("storage:previewTruncated", { size: formatBytes(MAX_TEXT_BYTES) })}
        </p>
      )}
    </div>
  );
}

function Unavailable({ file, lang, reason }: { file: PreviewFile; lang: string; reason: "unsupported" | "failed" }) {
  const { t } = useTranslation(lang);
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <FileIcon className="h-12 w-12 text-muted-foreground" aria-hidden />
      <p className="text-sm text-muted-foreground">
        {t(reason === "failed" ? "storage:previewFailed" : "storage:previewUnsupported")}
      </p>
      <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => downloadPreviewFile(file)}>
        <Download className="h-4 w-4" aria-hidden />
        {t("storage:download")}
      </Button>
    </div>
  );
}

/** A spinner over media until the element can show something; LFS media can take a moment. */
function MediaLoading({ lang }: { lang: string }) {
  const { t } = useTranslation(lang);
  return (
    <span role="status" className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-hidden />
      <span className="sr-only">{t("storage:previewLoading")}</span>
    </span>
  );
}

function PreviewBody({ file, lang }: { file: PreviewFile; lang: string }) {
  // Each state names the URL it belongs to, so another file starts out loading
  // and an event from the last one cannot reach it.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const failed = failedUrl === file.url;
  const loaded = loadedUrl === file.url;
  const kind = previewKind(file.mimeType);
  if (failed) return <Unavailable file={file} lang={lang} reason="failed" />;
  const media = { onError: () => setFailedUrl(file.url), className: cn("transition-opacity", !loaded && "opacity-0") };
  switch (kind) {
    case "image":
      return (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img key={file.url} {...contentImageSources(file.url, "preview", { intrinsicSizing: true })} alt={file.name} onLoad={() => setLoadedUrl(file.url)} {...media}
            decoding="async"
            className={cn(media.className, "max-h-full max-w-full object-contain")} />
          {!loaded && <MediaLoading lang={lang} />}
        </>
      );
    case "video":
      return (
        <>
          <video key={file.url} src={file.url} controls preload="metadata" onLoadedMetadata={() => setLoadedUrl(file.url)} {...media}
            className={cn(media.className, "max-h-full max-w-full")} />
          {!loaded && <MediaLoading lang={lang} />}
        </>
      );
    case "audio":
      return (
        <>
          <audio key={file.url} src={file.url} controls preload="metadata" onLoadedMetadata={() => setLoadedUrl(file.url)} {...media}
            className={cn(media.className, "w-full max-w-xl")} />
          {!loaded && <MediaLoading lang={lang} />}
        </>
      );
    case "text":
      return <TextPreview key={file.url} file={file} lang={lang} />;
    default:
      return <Unavailable file={file} lang={lang} reason="unsupported" />;
  }
}

/**
 * Shows one file of `files` at a time. Arrow keys and the side buttons move
 * through the list; media streams from its content route with byte ranges.
 */
export function FilePreviewDialog({
  files,
  index,
  onIndexChange,
  lang,
}: {
  files: PreviewFile[];
  index: number | null;
  onIndexChange: (index: number | null) => void;
  lang: string;
}) {
  const { t } = useTranslation(lang);
  const file = index === null ? undefined : files[index];
  const move = (step: number) => {
    if (index === null) return;
    const next = index + step;
    if (next >= 0 && next < files.length) onIndexChange(next);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    // Media controls use the arrow keys while they have focus.
    if (event.target instanceof HTMLMediaElement) return;
    if (event.key === "ArrowLeft") { event.preventDefault(); move(-1); }
    if (event.key === "ArrowRight") { event.preventDefault(); move(1); }
  };

  return (
    <Dialog open={file !== undefined} onOpenChange={(open) => { if (!open) onIndexChange(null); }}>
      <DialogContent
        className="flex h-[85vh] max-w-[calc(100%-2rem)] flex-col gap-3 p-4 sm:max-w-5xl"
        onKeyDown={onKeyDown}
      >
        {file && (
          <>
            <div className="flex min-w-0 items-center gap-2 pr-8">
              <div className="min-w-0 flex-1">
                <DialogTitle className="truncate text-base">{file.name}</DialogTitle>
                <DialogDescription className="tabular-nums">
                  {formatBytes(file.size)}
                  {files.length > 1 && ` · ${t("storage:previewPosition", { index: index! + 1, count: files.length })}`}
                </DialogDescription>
              </div>
              <Button type="button" variant="ghost" size="icon" onClick={() => downloadPreviewFile(file)} aria-label={t("storage:download")}>
                <Download className="h-4 w-4" aria-hidden />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => window.open(file.url, "_blank", "noopener,noreferrer")}
                aria-label={t("storage:open")}
              >
                <ExternalLink className="h-4 w-4" aria-hidden />
              </Button>
            </div>
            {/* The side buttons get their own margins so they never cover a player's controls. */}
            <div
              className={cn(
                "relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-md bg-muted/40 py-2",
                files.length > 1 ? "px-14" : "px-2",
              )}
            >
              <PreviewBody file={file} lang={lang} />
              {index! > 0 && (
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full shadow"
                  onClick={() => move(-1)}
                  aria-label={t("storage:previewPrevious")}
                >
                  <ChevronLeft className="h-5 w-5" aria-hidden />
                </Button>
              )}
              {index! < files.length - 1 && (
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full shadow"
                  onClick={() => move(1)}
                  aria-label={t("storage:previewNext")}
                >
                  <ChevronRight className="h-5 w-5" aria-hidden />
                </Button>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
