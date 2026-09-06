"use client";

import type { Row } from "@tanstack/react-table";
import { Folder, Globe, Package } from "lucide-react";
import { forwardRef, type HTMLAttributes, useState } from "react";
import { Checkbox } from "@beutl/ui/ui/checkbox";
import { cn, formatBytes } from "@beutl/core";
import { useTranslation } from "@beutl/ui/i18n-client";
import {
  contentUrl,
  fileKind,
  fileKindIcon,
  hasThumbnail,
  RAW,
} from "./file-kind";
import {
  FolderActionsButton,
  RowActionsButton,
  type FileListHandlers,
  type FolderHandlers,
} from "./file-actions";
import { useVisibilitySpec } from "./visibility-badge";
import type { StorageFile, StorageFolder } from "./types";

type FileCardProps = {
  row: Row<StorageFile>;
  lang: string;
  busy: boolean;
  handlers: FileListHandlers;
  // While anything is selected every checkbox shows, so the next click is
  // visibly a selection and not an open.
  showCheckbox: boolean;
  // Folder path, shown only for search results from elsewhere.
  location?: string | null;
} & HTMLAttributes<HTMLDivElement>;

// forwardRef so a context-menu trigger can wrap the card.
export const FileCard = forwardRef<HTMLDivElement, FileCardProps>(
  function FileCard(
    { row, lang, busy, handlers, showCheckbox, location, className, ...rest },
    ref,
  ) {
    const file = row.original;
    const { t } = useTranslation(lang);
    const kind = fileKind(file.mimeType);
    const Icon = fileKindIcon(kind);
    const visibility = useVisibilitySpec(file.visibility, lang);
    const [thumbnailFailed, setThumbnailFailed] = useState(false);
    const selected = row.getIsSelected();
    const thumbnail = hasThumbnail(file) && !thumbnailFailed;

    return (
      <div
        ref={ref}
        role="option"
        aria-selected={selected}
        className={cn(
          "group relative flex select-none flex-col overflow-hidden rounded-lg border bg-card text-card-foreground outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring",
          selected && "border-primary/60 bg-primary/10 hover:bg-primary/15",
          className,
        )}
        {...rest}
      >
        <div className="relative flex aspect-[4/3] items-center justify-center overflow-hidden bg-muted/40">
          {thumbnail ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={contentUrl(file)}
              alt=""
              loading="lazy"
              decoding="async"
              draggable={false}
              onError={() => setThumbnailFailed(true)}
              className="h-full w-full object-cover"
            />
          ) : (
            <Icon className="h-10 w-10 text-muted-foreground" aria-hidden />
          )}
          <Checkbox
            className={cn(
              "absolute left-2 top-2 bg-background/80 backdrop-blur-sm transition-opacity",
              selected || showCheckbox
                ? "opacity-100"
                : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100",
            )}
            checked={selected}
            onCheckedChange={(value) => row.toggleSelected(!!value)}
            aria-label={t("storage:selectRow", { name: file.name, ...RAW })}
          />
          {file.visibility !== "PRIVATE" && (
            <span
              className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-background/80 text-muted-foreground backdrop-blur-sm"
              title={visibility.label}
            >
              {file.visibility === "PUBLIC" ? (
                <Globe className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <Package className="h-3.5 w-3.5" aria-hidden />
              )}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 px-3 py-2">
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <span
            className="min-w-0 flex-1 truncate text-sm font-medium"
            title={file.name}
          >
            {file.name}
          </span>
          <RowActionsButton
            file={file}
            lang={lang}
            busy={busy}
            handlers={handlers}
            className="-mr-1.5 h-7 w-7"
          />
        </div>
        <div className="flex flex-col gap-0.5 px-3 pb-2.5 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="tabular-nums">{formatBytes(Number(file.size))}</span>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1">
              <visibility.Icon className="h-3 w-3" aria-hidden />
              {visibility.label}
            </span>
          </span>
          {location && (
            <span className="truncate" title={location}>
              {location}
            </span>
          )}
        </div>
      </div>
    );
  },
);

type FolderCardProps = {
  folder: StorageFolder;
  lang: string;
  busy: boolean;
  handlers: FolderHandlers;
  location?: string | null;
} & HTMLAttributes<HTMLDivElement>;

export const FolderCard = forwardRef<HTMLDivElement, FolderCardProps>(
  function FolderCard(
    { folder, lang, busy, handlers, location, className, ...rest },
    ref,
  ) {
    return (
      <div
        ref={ref}
        role="button"
        tabIndex={0}
        className={cn(
          "group flex select-none items-center gap-2 rounded-lg border bg-card px-3 py-2.5 text-card-foreground outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring data-[drop-active=true]:border-primary data-[drop-active=true]:bg-primary/10",
          className,
        )}
        {...rest}
      >
        <Folder className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium" title={folder.name}>
            {folder.name}
          </span>
          {location && (
            <span className="truncate text-xs text-muted-foreground" title={location}>
              {location}
            </span>
          )}
        </span>
        <FolderActionsButton
          folder={folder}
          lang={lang}
          busy={busy}
          handlers={handlers}
          className="-mr-1.5 h-7 w-7"
        />
      </div>
    );
  },
);
