"use client";

import { ChevronDown, ChevronRight, Folder, HardDrive, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState, useTransition } from "react";
import { Button } from "@beutl/ui/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@beutl/ui/ui/dialog";
import { cn } from "@beutl/core";
import { useTranslation } from "@beutl/ui/i18n-client";
import type { StorageFolder } from "./types";

export function MoveDialog({
  open,
  onOpenChange,
  lang,
  folders,
  currentFolderId,
  disabledFolderIds,
  title,
  onMove,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lang: string;
  folders: StorageFolder[];
  // Where the items are now; picking it again is a no-op and stays disabled.
  currentFolderId: string | null;
  // A folder being moved, and everything under it, cannot be its own target.
  disabledFolderIds: ReadonlySet<string>;
  title: string;
  onMove: (targetId: string | null) => Promise<boolean>;
}) {
  const { t } = useTranslation(lang);
  const [target, setTarget] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [pending, startTransition] = useTransition();

  const byId = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder])),
    [folders],
  );
  const children = useMemo(() => {
    const map = new Map<string | null, StorageFolder[]>();
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

  // Open on the current location with its ancestors unfolded, the way a file
  // manager's "move to" sheet does.
  useEffect(() => {
    if (!open) return;
    setTarget(currentFolderId);
    const path = new Set<string>();
    let cursor = currentFolderId;
    while (cursor !== null && !path.has(cursor)) {
      path.add(cursor);
      cursor = byId.get(cursor)?.parentId ?? null;
    }
    setExpanded(path);
  }, [open, currentFolderId, byId]);

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderNode = (folder: StorageFolder, depth: number) => {
    const kids = children.get(folder.id) ?? [];
    const isOpen = expanded.has(folder.id);
    const disabled = disabledFolderIds.has(folder.id);
    return (
      <li key={folder.id}>
        <div
          className={cn(
            "flex items-center gap-0.5 rounded-md pr-1",
            target === folder.id && "bg-primary/10",
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
            aria-checked={target === folder.id}
            disabled={disabled}
            className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
            onClick={() => setTarget(folder.id)}
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
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t("storage:moveDescription")}</DialogDescription>
        </DialogHeader>
        <div
          role="radiogroup"
          aria-label={title}
          className="max-h-72 overflow-y-auto rounded-md border p-1"
        >
          <ul>
            <li>
              <div
                className={cn(
                  "flex items-center rounded-md pr-1",
                  target === null && "bg-primary/10",
                )}
              >
                <span className="w-6 shrink-0" aria-hidden />
                <button
                  type="button"
                  role="radio"
                  aria-checked={target === null}
                  className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left text-sm hover:bg-accent"
                  onClick={() => setTarget(null)}
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
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {t("cancel")}
          </Button>
          <Button
            type="button"
            disabled={pending || target === currentFolderId}
            onClick={() =>
              startTransition(async () => {
                const ok = await onMove(target);
                if (ok) onOpenChange(false);
              })
            }
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {t("storage:moveHere")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
