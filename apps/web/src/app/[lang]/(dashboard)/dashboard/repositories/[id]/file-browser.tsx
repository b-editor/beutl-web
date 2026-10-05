"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type KeyboardEvent } from "react";
import { ChevronRight, CornerLeftUp, Download, Eye, Folder, FolderGit2 } from "lucide-react";
import { cn, fileKind, formatBytes, mimeTypeFromFileName, type GitTreeEntry } from "@beutl/core";
import { useTranslation } from "@beutl/ui/i18n-client";
import { Badge } from "@beutl/ui/ui/badge";
import { Button } from "@beutl/ui/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beutl/ui/ui/table";
import { downloadPreviewFile, FilePreviewDialog, type PreviewFile } from "@/components/dashboard/file-preview";
import { fileKindIcon } from "../../storage/file-kind";
import { repositoryContentUrl, repositoryHref } from "./links";

const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");
const bytesOf = (entry: GitTreeEntry) => entry.lfs?.size ?? entry.size ?? 0;
// Same column layout as the storage list, so both screens read alike.
const CELL = "py-2";

function Breadcrumbs({ lang, repositoryId, repositoryName, refName, path }: {
  lang: string; repositoryId: string; repositoryName: string; refName: string; path: string;
}) {
  const { t } = useTranslation(lang);
  const segments = path === "" ? [] : path.split("/");
  return (
    <nav aria-label={t("dashboard:repositories.browser.location")} className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
      <Link prefetch={false} href={repositoryHref(lang, repositoryId, "files", { ref: refName })} className="font-medium hover:underline">
        {repositoryName}
      </Link>
      {segments.map((segment, index) => {
        const last = index === segments.length - 1;
        return (
          <span key={index} className="flex min-w-0 items-center gap-1">
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            {last ? (
              <span className="truncate font-medium" aria-current="page">{segment}</span>
            ) : (
              <Link prefetch={false}
                href={repositoryHref(lang, repositoryId, "files", { ref: refName, path: segments.slice(0, index + 1).join("/") })}
                className="truncate hover:underline"
              >
                {segment}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/**
 * One directory of a commit. Folders open in place; files open in the shared
 * preview, which moves through this directory's files. The URL follows the
 * open file, so it can be shared and reloaded.
 */
export function FileBrowser({
  lang,
  repositoryId,
  repositoryName,
  refName,
  commit,
  path,
  entries,
  opened,
}: {
  lang: string;
  repositoryId: string;
  repositoryName: string;
  refName: string;
  commit: string;
  path: string;
  entries: GitTreeEntry[];
  /** A file of this directory to preview at once. */
  opened?: string;
}) {
  const { t } = useTranslation(lang);
  const router = useRouter();
  const files = entries.filter((entry) => entry.type === "blob");
  const previews: PreviewFile[] = files.map((entry) => ({
    key: entry.path,
    name: entry.name,
    url: repositoryContentUrl(repositoryId, commit, entry.path),
    mimeType: mimeTypeFromFileName(entry.name),
    size: bytesOf(entry),
  }));
  const [previewPath, setPreviewPath] = useState<string | null>(opened ?? null);
  const previewIndex = previews.findIndex((file) => file.key === previewPath);
  const showPreview = (filePath: string | null) => {
    setPreviewPath(filePath);
    // A shallow URL update: the directory's data is already here.
    window.history.replaceState(null, "", repositoryHref(lang, repositoryId, "files", { ref: refName, path: filePath ?? path }));
  };
  const open = (entry: GitTreeEntry) => {
    if (entry.type === "tree") router.push(repositoryHref(lang, repositoryId, "files", { ref: refName, path: entry.path }));
    else if (entry.type === "blob") showPreview(entry.path);
  };
  const onRowKeyDown = (event: KeyboardEvent, entry: GitTreeEntry) => {
    if (event.target !== event.currentTarget || event.key !== "Enter") return;
    event.preventDefault();
    open(entry);
  };

  return (
    <div className="flex flex-col gap-3">
      <Breadcrumbs lang={lang} repositoryId={repositoryId} repositoryName={repositoryName} refName={refName} path={path} />
      <div className="rounded-md border">
        <Table aria-label={t("dashboard:repositories.browser.files")}>
          <TableHeader>
            <TableRow>
              <TableHead className="h-10 w-full min-w-40 max-w-0">{t("storage:sortName")}</TableHead>
              <TableHead className="hidden h-10 w-28 whitespace-nowrap text-right sm:table-cell">{t("storage:size")}</TableHead>
              <TableHead className="h-10 w-24 pl-0"><span className="sr-only">{t("dashboard:repositories.actions")}</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {path !== "" && (
              <TableRow
                tabIndex={0}
                className="cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                onClick={() => router.push(repositoryHref(lang, repositoryId, "files", { ref: refName, path: parentOf(path) }))}
                onKeyDown={(event) => {
                  if (event.key === "Enter") router.push(repositoryHref(lang, repositoryId, "files", { ref: refName, path: parentOf(path) }));
                }}
              >
                <TableCell className={cn(CELL, "w-full min-w-40 max-w-0")} colSpan={3}>
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <CornerLeftUp className="size-4 shrink-0" aria-hidden />
                    {t("dashboard:repositories.browser.parent")}
                  </span>
                </TableCell>
              </TableRow>
            )}
            {entries.map((entry) => {
              const Icon = entry.type === "tree" ? Folder : entry.type === "submodule" ? FolderGit2 : fileKindIcon(fileKind(mimeTypeFromFileName(entry.name)));
              const openable = entry.type !== "submodule";
              return (
                <TableRow
                  key={entry.path}
                  tabIndex={openable ? 0 : undefined}
                  className={cn(
                    "group outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    openable && "cursor-pointer",
                  )}
                  onClick={(event) => {
                    if ((event.target as HTMLElement).closest("button, a")) return;
                    open(entry);
                  }}
                  onKeyDown={(event) => onRowKeyDown(event, entry)}
                >
                  <TableCell className={cn(CELL, "w-full min-w-40 max-w-0")}>
                    <div className="flex min-w-0 items-center gap-2 font-medium" title={entry.name}>
                      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="flex min-w-0 flex-col">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate">{entry.name}</span>
                          {entry.lfs && <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">LFS</Badge>}
                          {entry.type === "submodule" && (
                            <span className="text-xs font-normal text-muted-foreground">{t("dashboard:repositories.browser.submodule")}</span>
                          )}
                        </span>
                        {entry.type === "blob" && (
                          <span className="text-xs font-normal tabular-nums text-muted-foreground sm:hidden">{formatBytes(bytesOf(entry))}</span>
                        )}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className={cn(CELL, "hidden w-28 whitespace-nowrap text-right tabular-nums text-muted-foreground sm:table-cell")}>
                    {entry.type === "blob" ? formatBytes(bytesOf(entry)) : "—"}
                  </TableCell>
                  <TableCell className={cn(CELL, "w-24 pl-0")}>
                    {entry.type === "blob" && (
                      <div className="flex justify-end opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          onClick={() => showPreview(entry.path)}
                          aria-label={t("storage:preview")}
                          title={t("storage:preview")}
                        >
                          <Eye className="size-4" aria-hidden />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          onClick={() => downloadPreviewFile(previews.find((file) => file.key === entry.path)!)}
                          aria-label={t("storage:download")}
                          title={t("storage:download")}
                        >
                          <Download className="size-4" aria-hidden />
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {entries.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="h-12 text-center text-sm text-muted-foreground">
                  {t("dashboard:repositories.browser.emptyDirectory")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <FilePreviewDialog
        files={previews}
        index={previewIndex < 0 ? null : previewIndex}
        onIndexChange={(index) => showPreview(index === null ? null : previews[index].key)}
        lang={lang}
      />
    </div>
  );
}
