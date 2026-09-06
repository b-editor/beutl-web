"use client";

import { X } from "lucide-react";
import { useState } from "react";
import { Button } from "@beutl/ui/ui/button";
import { cn, formatBytes, formatDateTime } from "@beutl/core";
import { useTranslation } from "@beutl/ui/i18n-client";
import {
  contentUrl,
  fileKind,
  fileKindIcon,
  hasThumbnail,
} from "./file-kind";
import { useFileActions, type FileListHandlers } from "./file-actions";
import { VisibilityBadge } from "./visibility-badge";
import type { StorageFile } from "./types";

function Preview({ file }: { file: StorageFile }) {
  const [failed, setFailed] = useState(false);
  const Icon = fileKindIcon(fileKind(file.mimeType));
  return (
    <div className="flex aspect-video items-center justify-center overflow-hidden rounded-md bg-muted/40">
      {hasThumbnail(file) && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={contentUrl(file)}
          alt=""
          decoding="async"
          onError={() => setFailed(true)}
          className="h-full w-full object-contain"
        />
      ) : (
        <Icon className="h-12 w-12 text-muted-foreground" aria-hidden />
      )}
    </div>
  );
}

export function DetailsPanel({
  files,
  lang,
  busy,
  handlers,
  locationOf,
  onClose,
}: {
  files: StorageFile[];
  lang: string;
  busy: boolean;
  handlers: FileListHandlers;
  locationOf: (file: StorageFile) => string;
  onClose: () => void;
}) {
  const { t } = useTranslation(lang);
  const single = files.length === 1 ? files[0] : null;
  // The pane is already showing details, so that action is left out here.
  const { actions, note } = useFileActions(files, lang, {
    ...handlers,
    detailsAvailable: false,
  });
  const totalBytes = files.reduce((sum, file) => sum + Number(file.size), 0);

  return (
    <aside
      className="flex w-80 shrink-0 flex-col gap-4 self-start rounded-lg border bg-card p-4 text-card-foreground"
      aria-label={t("storage:details")}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t("storage:details")}</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="-mr-2 h-8 w-8"
          onClick={onClose}
          aria-label={t("storage:hideDetails")}
        >
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      {files.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("storage:detailsEmpty")}
        </p>
      ) : single ? (
        <>
          <Preview file={single} />
          <div className="flex flex-col gap-2">
            <p className="break-all font-medium">{single.name}</p>
            <div>
              <VisibilityBadge visibility={single.visibility} lang={lang} />
            </div>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">{t("storage:type")}</dt>
            <dd>{t(`storage:kinds.${fileKind(single.mimeType)}`)}</dd>
            <dt className="text-muted-foreground">{t("storage:mimeType")}</dt>
            <dd className="break-all">{single.mimeType}</dd>
            <dt className="text-muted-foreground">{t("storage:size")}</dt>
            <dd className="tabular-nums">{formatBytes(Number(single.size))}</dd>
            <dt className="text-muted-foreground">{t("storage:createdAt")}</dt>
            <dd className="tabular-nums">
              {formatDateTime(single.createdAt, lang)}
            </dd>
            <dt className="text-muted-foreground">{t("storage:location")}</dt>
            <dd className="break-all">{locationOf(single)}</dd>
          </dl>
        </>
      ) : (
        <>
          <p className="font-medium">
            {t("storage:selectedCount", { count: files.length })}
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">{t("storage:totalSize")}</dt>
            <dd className="tabular-nums">{formatBytes(totalBytes)}</dd>
          </dl>
        </>
      )}

      {actions.length > 0 && (
        <div className="flex flex-col gap-0.5 border-t pt-3">
          {actions.map((action) => (
            <Button
              key={action.id}
              type="button"
              variant="ghost"
              size="sm"
              className={cn(
                "justify-start gap-2",
                action.destructive &&
                  "text-destructive hover:bg-destructive/10 hover:text-destructive",
              )}
              disabled={busy}
              onClick={() => void action.run()}
            >
              <action.icon className="h-4 w-4" aria-hidden />
              {action.label}
            </Button>
          ))}
        </div>
      )}
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </aside>
  );
}
