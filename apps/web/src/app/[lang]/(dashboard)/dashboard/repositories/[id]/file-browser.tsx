"use client";

import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronRight,
  Download,
  ExternalLink,
  Eye,
  Folder,
  FolderGit2,
  FolderOpen,
  LayoutGrid,
  List as ListIcon,
  MoreVertical,
} from "lucide-react";
import {
  forwardRef,
  Fragment,
  useEffect,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { cn, fileKind, formatBytes, mimeTypeFromFileName, type GitTreeEntry } from "@beutl/core";
import { useTranslation } from "@beutl/ui/i18n-client";
import { Badge } from "@beutl/ui/ui/badge";
import { Button } from "@beutl/ui/ui/button";
import { ContextMenu, ContextMenuTrigger } from "@beutl/ui/ui/context-menu";
import { DropdownMenu, DropdownMenuTrigger } from "@beutl/ui/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beutl/ui/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@beutl/ui/ui/toggle-group";
import {
  downloadPreviewFile,
  FilePreviewDialog,
  previewKind,
  type PreviewFile,
} from "@/components/dashboard/file-preview";
import { fileKindIcon, RAW } from "../../storage/file-kind";
import { ActionContextContent, ActionDropdownContent, type ItemAction } from "../../storage/file-actions";
import { repositoryContentUrl, repositoryHref } from "./links";
import { PendingArea, useRepositoryNavigation } from "./navigation";

type ViewMode = "list" | "grid";
type Sorting = { field: "name" | "size"; descending: boolean };

const VIEW_STORAGE_KEY = "beutl.repository.view";
// The storage list's layout, so the two screens read alike.
const CELL_CLASS = "py-2";
const HEAD_CLASS = "h-10";
const COLUMN_CLASS = {
  name: "w-full min-w-40 max-w-0",
  size: "hidden w-28 whitespace-nowrap text-right sm:table-cell",
  actions: "w-12 pl-0",
};
const GRID_CLASS = "grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5";
// There is no thumbnail service; a card shows the original, up to this size.
const THUMBNAIL_MAX_BYTES = 8 * 1024 * 1024;

const bytesOf = (entry: GitTreeEntry) => entry.lfs?.size ?? entry.size ?? 0;

function readStoredView(): ViewMode | null {
  try {
    const value = window.localStorage.getItem(VIEW_STORAGE_KEY);
    return value === "grid" || value === "list" ? value : null;
  } catch {
    // A blocked store only loses the preference.
    return null;
  }
}

function storeView(view: ViewMode): void {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // A blocked store only loses the preference.
  }
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("a, button, input, [role='menuitem']") !== null;
}

function entryIcon(entry: GitTreeEntry) {
  if (entry.type === "tree") return Folder;
  if (entry.type === "submodule") return FolderGit2;
  return fileKindIcon(fileKind(mimeTypeFromFileName(entry.name)));
}

function ActionsButton({ name, actions, lang, className }: { name: string; actions: ItemAction[]; lang: string; className?: string }) {
  const { t } = useTranslation(lang);
  if (actions.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className={cn("h-8 w-8", className)} aria-label={t("storage:actionsFor", { name, ...RAW })}>
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <ActionDropdownContent actions={actions} />
    </DropdownMenu>
  );
}

function ActionsContextMenu({ actions, children }: { actions: ItemAction[]; children: ReactNode }) {
  if (actions.length === 0) return <>{children}</>;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ActionContextContent actions={actions} />
    </ContextMenu>
  );
}

function SortHeader({ field, label, sorting, onSort, align = "left" }: {
  field: Sorting["field"]; label: string; sorting: Sorting; onSort: (sorting: Sorting) => void; align?: "left" | "right";
}) {
  const sorted = sorting.field === field ? (sorting.descending ? "desc" : "asc") : false;
  const Icon = sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : ArrowUpDown;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn("h-8 gap-1 px-2", align === "left" ? "-ml-2" : "-mr-2")}
      onClick={() => onSort({ field, descending: sorted === "asc" })}
    >
      {label}
      <Icon className={cn("h-3.5 w-3.5", !sorted && "text-muted-foreground")} aria-hidden />
    </Button>
  );
}

const FolderCard = forwardRef<HTMLDivElement, { entry: GitTreeEntry; actions: ItemAction[]; lang: string } & HTMLAttributes<HTMLDivElement>>(
  function FolderCard({ entry, actions, lang, className, ...rest }, ref) {
    const Icon = entryIcon(entry);
    return (
      <div
        ref={ref}
        role="button"
        tabIndex={0}
        className={cn(
          "group flex select-none items-center gap-2 rounded-lg border bg-card px-3 py-2.5 text-card-foreground outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
        {...rest}
      >
        <Icon className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={entry.name}>{entry.name}</span>
        <ActionsButton name={entry.name} actions={actions} lang={lang} className="-mr-1.5 h-7 w-7" />
      </div>
    );
  },
);

const FileCard = forwardRef<HTMLDivElement, {
  entry: GitTreeEntry; file: PreviewFile; actions: ItemAction[]; selected: boolean; lang: string;
} & HTMLAttributes<HTMLDivElement>>(
  function FileCard({ entry, file, actions, selected, lang, className, ...rest }, ref) {
    const [thumbnailFailed, setThumbnailFailed] = useState(false);
    const Icon = entryIcon(entry);
    const thumbnail = previewKind(file.mimeType) === "image" && file.size > 0 && file.size <= THUMBNAIL_MAX_BYTES && !thumbnailFailed;
    return (
      <div
        ref={ref}
        role="option"
        tabIndex={0}
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
              src={file.url}
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
          {entry.lfs && (
            <Badge variant="secondary" className="absolute right-2 top-2 bg-background/80 px-1.5 py-0 text-[10px] font-normal backdrop-blur-sm">
              LFS
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2 px-3 py-2">
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={entry.name}>{entry.name}</span>
          <ActionsButton name={entry.name} actions={actions} lang={lang} className="-mr-1.5 h-7 w-7" />
        </div>
        <div className="px-3 pb-2.5 text-xs tabular-nums text-muted-foreground">{formatBytes(file.size)}</div>
      </div>
    );
  },
);

/**
 * One directory of a commit, laid out like the storage screen: folders open
 * on a click, files are selected on a click and open in the shared preview on
 * a double-click or Enter, which then moves through this folder's files. The
 * URL follows the open file, so it can be shared and reloaded.
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
  const { navigate } = useRepositoryNavigation();
  const [view, setView] = useState<ViewMode>("list");
  useEffect(() => {
    const stored = readStoredView();
    if (stored) setView(stored);
  }, []);
  const [sorting, setSorting] = useState<Sorting>({ field: "name", descending: false });
  const [selected, setSelected] = useState<string | null>(opened ?? null);
  const [previewPath, setPreviewPath] = useState<string | null>(opened ?? null);

  const byName = (a: GitTreeEntry, b: GitTreeEntry) => a.name.localeCompare(b.name, lang, { numeric: true });
  const direction = sorting.descending ? -1 : 1;
  // Folders always come first, as on the storage screen.
  const folders = entries.filter((entry) => entry.type !== "blob")
    .sort((a, b) => (sorting.field === "name" ? direction : 1) * byName(a, b));
  const files = entries.filter((entry) => entry.type === "blob")
    .sort((a, b) => direction * (sorting.field === "size" ? bytesOf(a) - bytesOf(b) || byName(a, b) : byName(a, b)));
  const previews: PreviewFile[] = files.map((entry) => ({
    key: entry.path,
    name: entry.name,
    url: repositoryContentUrl(repositoryId, commit, entry.path),
    mimeType: mimeTypeFromFileName(entry.name),
    size: bytesOf(entry),
  }));
  const previewOf = (entry: GitTreeEntry) => previews.find((file) => file.key === entry.path)!;
  const previewIndex = previews.findIndex((file) => file.key === previewPath);
  const folderHref = (folderPath: string) => repositoryHref(lang, repositoryId, "files", { ref: refName, path: folderPath });

  const showPreview = (filePath: string | null) => {
    setPreviewPath(filePath);
    if (filePath) setSelected(filePath);
    // A shallow URL update: the directory's data is already here.
    window.history.replaceState(null, "", repositoryHref(lang, repositoryId, "files", { ref: refName, path: filePath ?? path }));
  };
  const actionsOf = (entry: GitTreeEntry): ItemAction[] => {
    if (entry.type === "tree") {
      return [{ id: "open", label: t("storage:openFolder"), icon: FolderOpen, group: 0, run: () => navigate(folderHref(entry.path)) }];
    }
    if (entry.type !== "blob") return [];
    const file = previewOf(entry);
    return [
      { id: "preview", label: t("storage:preview"), icon: Eye, group: 0, run: () => showPreview(entry.path) },
      { id: "open", label: t("storage:open"), icon: ExternalLink, group: 0, run: () => { window.open(file.url, "_blank", "noopener,noreferrer"); } },
      { id: "download", label: t("storage:download"), icon: Download, group: 0, run: () => downloadPreviewFile(file) },
    ];
  };

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !(event.target as HTMLElement | null)?.closest("[role='dialog'], [role='menu']")) setSelected(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const folderProps = (entry: GitTreeEntry) => ({
    tabIndex: entry.type === "tree" ? 0 : undefined,
    onClick: (event: MouseEvent) => {
      if (isInteractiveTarget(event.target) || entry.type !== "tree") return;
      navigate(folderHref(entry.path));
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.target !== event.currentTarget || event.key !== "Enter" || entry.type !== "tree") return;
      event.preventDefault();
      navigate(folderHref(entry.path));
    },
  });
  const fileProps = (entry: GitTreeEntry) => ({
    tabIndex: 0,
    onClick: (event: MouseEvent) => {
      if (!isInteractiveTarget(event.target)) setSelected(entry.path);
    },
    onDoubleClick: (event: MouseEvent) => {
      if (!isInteractiveTarget(event.target)) showPreview(entry.path);
    },
    onContextMenu: () => setSelected(entry.path),
    onKeyDown: (event: KeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter") { event.preventDefault(); showPreview(entry.path); }
      else if (event.key === " ") { event.preventDefault(); setSelected(entry.path); }
    },
  });

  const segments = path === "" ? [] : path.split("/");
  const breadcrumbs = (
    <nav aria-label={t("storage:location")} className="flex min-w-0 flex-wrap items-center gap-0.5 text-sm">
      {[null, ...segments].map((segment, index, all) => {
        const last = index === all.length - 1;
        const label = segment ?? repositoryName;
        return (
          <Fragment key={index}>
            {index > 0 && <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
            {last ? (
              <h2 className="flex min-w-0 items-center gap-1.5 px-1.5 text-base font-semibold" aria-current="location">
                {segment === null && <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
                <span className="truncate">{label}</span>
              </h2>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 max-w-[14rem] gap-1.5 px-1.5 text-muted-foreground"
                onClick={() => navigate(folderHref(segments.slice(0, index).join("/")))}
              >
                {segment === null && <FolderGit2 className="h-4 w-4 shrink-0" aria-hidden />}
                <span className="truncate">{label}</span>
              </Button>
            )}
          </Fragment>
        );
      })}
    </nav>
  );

  let content: ReactNode;
  if (entries.length === 0) {
    content = (
      <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed px-6 py-16 text-center">
        <Folder className="h-10 w-10 text-muted-foreground" aria-hidden />
        <p className="font-medium">{t("storage:emptyFolder")}</p>
      </div>
    );
  } else if (view === "grid") {
    content = (
      <div className="flex flex-col gap-5">
        {folders.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("storage:folders")}</h3>
            <div className={GRID_CLASS}>
              {folders.map((entry) => (
                <ActionsContextMenu key={entry.path} actions={actionsOf(entry)}>
                  <FolderCard entry={entry} actions={actionsOf(entry)} lang={lang} className={cn(entry.type !== "tree" && "cursor-default")} {...folderProps(entry)} />
                </ActionsContextMenu>
              ))}
            </div>
          </section>
        )}
        {files.length > 0 && (
          <section className="flex flex-col gap-2">
            {folders.length > 0 && (
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("storage:files")}</h3>
            )}
            <div
              role="listbox"
              aria-label={t("storage:files")}
              className={GRID_CLASS}
              onClick={(event) => { if (event.target === event.currentTarget) setSelected(null); }}
            >
              {files.map((entry) => (
                <ActionsContextMenu key={entry.path} actions={actionsOf(entry)}>
                  <FileCard
                    entry={entry}
                    file={previewOf(entry)}
                    actions={actionsOf(entry)}
                    selected={selected === entry.path}
                    lang={lang}
                    {...fileProps(entry)}
                  />
                </ActionsContextMenu>
              ))}
            </div>
          </section>
        )}
      </div>
    );
  } else {
    content = (
      <div className="rounded-md border">
        <Table aria-label={t("storage:files")}>
          <TableHeader>
            <TableRow>
              <TableHead className={cn(HEAD_CLASS, COLUMN_CLASS.name)}>
                <SortHeader field="name" label={t("storage:sortName")} sorting={sorting} onSort={setSorting} />
              </TableHead>
              <TableHead className={cn(HEAD_CLASS, COLUMN_CLASS.size)}>
                <SortHeader field="size" label={t("storage:size")} sorting={sorting} onSort={setSorting} align="right" />
              </TableHead>
              <TableHead className={cn(HEAD_CLASS, COLUMN_CLASS.actions)}>
                <span className="sr-only">{t("dashboard:repositories.actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {folders.map((entry) => {
              const Icon = entryIcon(entry);
              return (
                <ActionsContextMenu key={entry.path} actions={actionsOf(entry)}>
                  <TableRow
                    className={cn(
                      "group select-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      entry.type === "tree" ? "cursor-pointer" : "cursor-default",
                    )}
                    {...folderProps(entry)}
                  >
                    <TableCell className={cn(CELL_CLASS, COLUMN_CLASS.name)}>
                      <div className="flex min-w-0 items-center gap-2 font-medium">
                        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="truncate" title={entry.name}>{entry.name}</span>
                        {entry.type === "submodule" && (
                          <span className="shrink-0 text-xs font-normal text-muted-foreground">{t("dashboard:repositories.browser.submodule")}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className={cn(CELL_CLASS, COLUMN_CLASS.size, "text-muted-foreground")}>—</TableCell>
                    <TableCell className={cn(CELL_CLASS, COLUMN_CLASS.actions)}>
                      <ActionsButton name={entry.name} actions={actionsOf(entry)} lang={lang} />
                    </TableCell>
                  </TableRow>
                </ActionsContextMenu>
              );
            })}
            {files.map((entry) => {
              const Icon = entryIcon(entry);
              return (
                <ActionsContextMenu key={entry.path} actions={actionsOf(entry)}>
                  <TableRow
                    className="group cursor-default select-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-[state=selected]:bg-primary/10"
                    data-state={selected === entry.path ? "selected" : undefined}
                    aria-selected={selected === entry.path}
                    {...fileProps(entry)}
                  >
                    <TableCell className={cn(CELL_CLASS, COLUMN_CLASS.name)}>
                      <div className="flex min-w-0 items-center gap-2 font-medium" title={entry.name}>
                        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="flex min-w-0 flex-col">
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate">{entry.name}</span>
                            {entry.lfs && <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">LFS</Badge>}
                          </span>
                          {/* Narrow screens drop the size column; the size moves under the name. */}
                          <span className="text-xs font-normal tabular-nums text-muted-foreground sm:hidden">{formatBytes(bytesOf(entry))}</span>
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className={cn(CELL_CLASS, COLUMN_CLASS.size, "tabular-nums text-muted-foreground")}>
                      {formatBytes(bytesOf(entry))}
                    </TableCell>
                    <TableCell className={cn(CELL_CLASS, COLUMN_CLASS.actions)}>
                      <ActionsButton name={entry.name} actions={actionsOf(entry)} lang={lang} />
                    </TableCell>
                  </TableRow>
                </ActionsContextMenu>
              );
            })}
          </TableBody>
        </Table>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        {breadcrumbs}
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          className="ml-auto"
          value={view}
          onValueChange={(value) => {
            if (value === "grid" || value === "list") {
              setView(value);
              storeView(value);
            }
          }}
          aria-label={t("storage:viewMode")}
        >
          <ToggleGroupItem value="grid" aria-label={t("storage:viewGrid")}>
            <LayoutGrid className="h-4 w-4" aria-hidden />
          </ToggleGroupItem>
          <ToggleGroupItem value="list" aria-label={t("storage:viewList")}>
            <ListIcon className="h-4 w-4" aria-hidden />
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      <PendingArea>{content}</PendingArea>
      <FilePreviewDialog
        files={previews}
        index={previewIndex < 0 ? null : previewIndex}
        onIndexChange={(index) => showPreview(index === null ? null : previews[index].key)}
        lang={lang}
      />
    </div>
  );
}
