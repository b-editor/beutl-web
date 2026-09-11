"use client";

import { ChevronDown, ChevronRight, Folder, HardDrive } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@beutl/core";
import { useTranslation } from "@beutl/ui/i18n-client";

export type PickableFolder = {
  id: string;
  name: string;
  parentId: string | null;
};

const NO_FOLDERS: ReadonlySet<string> = new Set();

// The folder tree as a radio group with the root on top, the way a file
// manager's "move to" sheet reads. Shared by moving files and by keeping an
// AI result in storage; the caller owns the chosen folder and the dialog
// around it.
export function FolderTreePicker({
  lang,
  folders,
  value,
  onChange,
  disabledFolderIds = NO_FOLDERS,
  label,
  // Which folder's ancestors start unfolded. Defaults to the chosen one.
  expandTo = value,
}: {
  lang: string;
  folders: PickableFolder[];
  value: string | null;
  onChange: (folderId: string | null) => void;
  // Folders that cannot be chosen (a folder being moved, and everything under it).
  disabledFolderIds?: ReadonlySet<string>;
  label: string;
  expandTo?: string | null;
}) {
  const { t } = useTranslation(lang);

  const byId = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder])),
    [folders],
  );
  const children = useMemo(() => {
    const map = new Map<string | null, PickableFolder[]>();
    for (const folder of folders) {
      const key =
        folder.parentId !== null && byId.has(folder.parentId)
          ? folder.parentId
          : null;
      const list = map.get(key);
      if (list) list.push(folder);
      else map.set(key, [folder]);
    }
    for (const list of map.values()) {
      list.sort((left, right) => left.name.localeCompare(right.name));
    }
    return map;
  }, [folders, byId]);

  // Opens on the starting location with its ancestors unfolded. Computed once:
  // the picker is mounted fresh each time its dialog opens.
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const path = new Set<string>();
    let cursor = expandTo;
    while (cursor !== null && !path.has(cursor)) {
      path.add(cursor);
      cursor = byId.get(cursor)?.parentId ?? null;
    }
    return path;
  });

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderNode = (folder: PickableFolder, depth: number) => {
    const kids = children.get(folder.id) ?? [];
    const isOpen = expanded.has(folder.id);
    const disabled = disabledFolderIds.has(folder.id);
    return (
      <li key={folder.id}>
        <div
          className={cn(
            "flex items-center gap-0.5 rounded-md pr-1",
            value === folder.id && "bg-primary/10",
          )}
          style={{ paddingLeft: depth * 16 }}
        >
          <button
            type="button"
            className="flex h-8 w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground disabled:opacity-0"
            onClick={() => toggle(folder.id)}
            disabled={kids.length === 0}
            aria-label={
              isOpen ? t("storage:collapseFolder") : t("storage:expandFolder")
            }
            aria-expanded={kids.length > 0 ? isOpen : undefined}
          >
            {isOpen ? (
              <ChevronDown className="h-4 w-4" aria-hidden />
            ) : (
              <ChevronRight className="h-4 w-4" aria-hidden />
            )}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={value === folder.id}
            disabled={disabled}
            className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
            onClick={() => onChange(folder.id)}
            onDoubleClick={() => {
              if (kids.length > 0) toggle(folder.id);
            }}
          >
            <Folder className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">{folder.name}</span>
          </button>
        </div>
        {isOpen && kids.length > 0 && (
          <ul>{kids.map((child) => renderNode(child, depth + 1))}</ul>
        )}
      </li>
    );
  };

  const roots = children.get(null) ?? [];

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="max-h-72 overflow-y-auto rounded-md border p-1"
    >
      <ul>
        <li>
          <div
            className={cn(
              "flex items-center rounded-md pr-1",
              value === null && "bg-primary/10",
            )}
          >
            <span className="w-6 shrink-0" aria-hidden />
            <button
              type="button"
              role="radio"
              aria-checked={value === null}
              className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left text-sm hover:bg-accent"
              onClick={() => onChange(null)}
            >
              <HardDrive className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">{t("storage:myStorage")}</span>
            </button>
          </div>
          {roots.length > 0 && (
            <ul>{roots.map((folder) => renderNode(folder, 1))}</ul>
          )}
        </li>
      </ul>
    </div>
  );
}
