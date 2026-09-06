"use client";

import {
  Download,
  ExternalLink,
  FolderInput,
  FolderOpen,
  Globe,
  Info,
  Link as LinkIcon,
  Loader2,
  Lock,
  type LucideIcon,
  MoreVertical,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@beutl/ui/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@beutl/ui/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@beutl/ui/ui/dropdown-menu";
import { Separator } from "@beutl/ui/ui/separator";
import { cn } from "@beutl/core";
import { useToast } from "@beutl/ui/use-toast";
import { useTranslation } from "@beutl/ui/i18n-client";
import {
  contentUrl,
  downloadFile,
  isDedicated,
  openFile,
  RAW,
} from "./file-kind";
import type { StorageFile, StorageFolder } from "./types";

export type FileVisibilityChange = "PRIVATE" | "PUBLIC";

// The list owns every dialog and request; menus, cards and the selection bar
// only ask for things through these.
export type FileListHandlers = {
  requestDelete: (files: StorageFile[]) => void;
  requestRename: (file: StorageFile) => void;
  requestMove: (files: StorageFile[]) => void;
  changeVisibility: (
    files: StorageFile[],
    visibility: FileVisibilityChange,
  ) => Promise<boolean>;
  showDetails: (file: StorageFile) => void;
  // Whether the details pane exists at this viewport.
  detailsAvailable: boolean;
};

export type FolderHandlers = {
  openFolder: (folder: StorageFolder) => void;
  requestRenameFolder: (folder: StorageFolder) => void;
  requestMoveFolder: (folder: StorageFolder) => void;
  requestDeleteFolder: (folder: StorageFolder) => void;
};

export type ItemAction = {
  id: string;
  label: string;
  icon: LucideIcon;
  run: () => void | Promise<void>;
  // Items in the same group sit together; a separator goes between groups.
  group: number;
  destructive?: boolean;
};

export function useFileActions(
  files: StorageFile[],
  lang: string,
  handlers: FileListHandlers,
): { actions: ItemAction[]; note: string | null } {
  const { t } = useTranslation(lang);
  const { toast } = useToast();
  const single = files.length === 1 ? files[0] : null;
  const editable = files.filter((file) => !isDedicated(file));
  const actions: ItemAction[] = [];

  if (single) {
    actions.push({
      id: "open",
      label: t("storage:open"),
      icon: ExternalLink,
      group: 0,
      run: () => openFile(single),
    });
    actions.push({
      id: "download",
      label: t("storage:download"),
      icon: Download,
      group: 0,
      run: () => downloadFile(single),
    });
    if (single.visibility === "PUBLIC") {
      actions.push({
        id: "copyLink",
        label: t("storage:copyLink"),
        icon: LinkIcon,
        group: 0,
        run: async () => {
          try {
            await navigator.clipboard.writeText(
              new URL(contentUrl(single), window.location.origin).toString(),
            );
            toast({ title: t("storage:linkCopied") });
          } catch {
            toast({
              title: t("error"),
              description: t("storage:copyFailed"),
              variant: "destructive",
            });
          }
        },
      });
    }
    if (!isDedicated(single)) {
      actions.push({
        id: "rename",
        label: t("storage:rename"),
        icon: Pencil,
        group: 1,
        run: () => handlers.requestRename(single),
      });
    }
  }
  if (files.length > 0) {
    actions.push({
      id: "move",
      label: t("storage:move"),
      icon: FolderInput,
      group: 1,
      run: () => handlers.requestMove(files),
    });
  }
  if (single && handlers.detailsAvailable) {
    actions.push({
      id: "details",
      label: t("storage:showDetails"),
      icon: Info,
      group: 1,
      run: () => handlers.showDetails(single),
    });
  }
  const toPublic = editable.filter((file) => file.visibility === "PRIVATE");
  const toPrivate = editable.filter((file) => file.visibility === "PUBLIC");
  if (toPublic.length > 0) {
    actions.push({
      id: "setPublic",
      label: t("storage:setToPublic"),
      icon: Globe,
      group: 2,
      run: async () => {
        await handlers.changeVisibility(toPublic, "PUBLIC");
      },
    });
  }
  if (toPrivate.length > 0) {
    actions.push({
      id: "setPrivate",
      label: t("storage:setToPrivate"),
      icon: Lock,
      group: 2,
      run: async () => {
        await handlers.changeVisibility(toPrivate, "PRIVATE");
      },
    });
  }
  if (editable.length > 0) {
    actions.push({
      id: "delete",
      label: t("delete"),
      icon: Trash2,
      group: 3,
      destructive: true,
      run: () => handlers.requestDelete(editable),
    });
  }

  const note =
    files.length > 0 && editable.length === 0
      ? t("storage:dedicatedHint")
      : null;
  return { actions, note };
}

export function useFolderActions(
  folder: StorageFolder,
  lang: string,
  handlers: FolderHandlers,
): { actions: ItemAction[] } {
  const { t } = useTranslation(lang);
  return {
    actions: [
      {
        id: "open",
        label: t("storage:openFolder"),
        icon: FolderOpen,
        group: 0,
        run: () => handlers.openFolder(folder),
      },
      {
        id: "rename",
        label: t("storage:rename"),
        icon: Pencil,
        group: 1,
        run: () => handlers.requestRenameFolder(folder),
      },
      {
        id: "move",
        label: t("storage:move"),
        icon: FolderInput,
        group: 1,
        run: () => handlers.requestMoveFolder(folder),
      },
      {
        id: "delete",
        label: t("delete"),
        icon: Trash2,
        group: 3,
        destructive: true,
        run: () => handlers.requestDeleteFolder(folder),
      },
    ],
  };
}

function groupActions(actions: ItemAction[]): ItemAction[][] {
  const groups = new Map<number, ItemAction[]>();
  for (const action of actions) {
    const list = groups.get(action.group);
    if (list) list.push(action);
    else groups.set(action.group, [action]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, list]) => list);
}

const DESTRUCTIVE_ITEM =
  "text-destructive focus:bg-destructive/10 focus:text-destructive";

export function ActionDropdownContent({
  actions,
  note,
  align = "end",
}: {
  actions: ItemAction[];
  note?: string | null;
  align?: "start" | "end";
}) {
  const groups = groupActions(actions);
  return (
    <DropdownMenuContent align={align} className="w-52">
      {groups.map((group, index) => (
        <div key={group[0].id}>
          {index > 0 && <DropdownMenuSeparator />}
          {group.map((action) => (
            <DropdownMenuItem
              key={action.id}
              className={cn(action.destructive && DESTRUCTIVE_ITEM)}
              onSelect={() => void action.run()}
            >
              <action.icon className="mr-2 h-4 w-4" aria-hidden />
              {action.label}
            </DropdownMenuItem>
          ))}
        </div>
      ))}
      {note && (
        <>
          {groups.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuLabel className="whitespace-normal text-xs font-normal text-muted-foreground">
            {note}
          </DropdownMenuLabel>
        </>
      )}
    </DropdownMenuContent>
  );
}

export function ActionContextContent({
  actions,
  note,
}: {
  actions: ItemAction[];
  note?: string | null;
}) {
  const groups = groupActions(actions);
  return (
    <ContextMenuContent className="w-52">
      {groups.map((group, index) => (
        <div key={group[0].id}>
          {index > 0 && <ContextMenuSeparator />}
          {group.map((action) => (
            <ContextMenuItem
              key={action.id}
              className={cn(action.destructive && DESTRUCTIVE_ITEM)}
              onSelect={() => void action.run()}
            >
              <action.icon className="mr-2 h-4 w-4" aria-hidden />
              {action.label}
            </ContextMenuItem>
          ))}
        </div>
      ))}
      {note && (
        <>
          {groups.length > 0 && <ContextMenuSeparator />}
          <ContextMenuLabel className="whitespace-normal text-xs font-normal text-muted-foreground">
            {note}
          </ContextMenuLabel>
        </>
      )}
    </ContextMenuContent>
  );
}

// Right-click (or long-press) menu around a row or card. `files` is the
// selection when the item is part of it, else the item alone; the list
// decides that, so this only renders.
export function FileContextMenu({
  files,
  lang,
  handlers,
  children,
}: {
  files: StorageFile[];
  lang: string;
  handlers: FileListHandlers;
  children: ReactNode;
}) {
  const { actions, note } = useFileActions(files, lang, handlers);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ActionContextContent actions={actions} note={note} />
    </ContextMenu>
  );
}

export function FolderContextMenu({
  folder,
  lang,
  handlers,
  children,
}: {
  folder: StorageFolder;
  lang: string;
  handlers: FolderHandlers;
  children: ReactNode;
}) {
  const { actions } = useFolderActions(folder, lang, handlers);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ActionContextContent actions={actions} />
    </ContextMenu>
  );
}

export function RowActionsButton({
  file,
  lang,
  busy,
  handlers,
  className,
}: {
  file: StorageFile;
  lang: string;
  busy: boolean;
  handlers: FileListHandlers;
  className?: string;
}) {
  const { t } = useTranslation(lang);
  const { actions, note } = useFileActions([file], lang, handlers);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn("h-8 w-8", className)}
          disabled={busy}
          aria-label={t("storage:actionsFor", { name: file.name, ...RAW })}
        >
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <ActionDropdownContent actions={actions} note={note} />
    </DropdownMenu>
  );
}

export function FolderActionsButton({
  folder,
  lang,
  busy,
  handlers,
  className,
}: {
  folder: StorageFolder;
  lang: string;
  busy: boolean;
  handlers: FolderHandlers;
  className?: string;
}) {
  const { t } = useTranslation(lang);
  const { actions } = useFolderActions(folder, lang, handlers);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn("h-8 w-8", className)}
          disabled={busy}
          aria-label={t("storage:actionsFor", { name: folder.name, ...RAW })}
        >
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <ActionDropdownContent actions={actions} />
    </DropdownMenu>
  );
}

// Replaces the filter row while something is selected, the way Drive does.
export function SelectionBar({
  files,
  lang,
  busy,
  handlers,
  onClear,
}: {
  files: StorageFile[];
  lang: string;
  busy: boolean;
  handlers: FileListHandlers;
  onClear: () => void;
}) {
  const { t } = useTranslation(lang);
  const { actions } = useFileActions(files, lang, handlers);
  const label = t("storage:selectedCount", { count: files.length });
  return (
    <div
      role="toolbar"
      aria-label={label}
      className="flex flex-wrap items-center gap-1 rounded-md border border-primary/30 bg-primary/5 px-2 py-1.5"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={onClear}
        aria-label={t("storage:clearSelection")}
      >
        <X className="h-4 w-4" aria-hidden />
      </Button>
      <span className="px-1 text-sm font-medium tabular-nums">{label}</span>
      <Separator orientation="vertical" className="mx-1 h-5" />
      {actions.map((action) => (
        <Button
          key={action.id}
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            "h-8 gap-1.5 px-2.5",
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
      {busy && (
        <Loader2
          className="ml-1 h-4 w-4 animate-spin text-muted-foreground"
          aria-hidden
        />
      )}
    </div>
  );
}
