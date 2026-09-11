"use client";

import { Loader2 } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@beutl/ui/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@beutl/ui/ui/dialog";
import { useTranslation } from "@beutl/ui/i18n-client";
import { FolderTreePicker } from "./folder-picker";
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
  const [pending, startTransition] = useTransition();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      {/* Mounted fresh on every open, so the choice starts at the current
          location each time. */}
      {open && (
        <MoveDialogBody
          lang={lang}
          folders={folders}
          currentFolderId={currentFolderId}
          disabledFolderIds={disabledFolderIds}
          title={title}
          pending={pending}
          onCancel={() => onOpenChange(false)}
          onMove={(target) =>
            startTransition(async () => {
              const ok = await onMove(target);
              if (ok) onOpenChange(false);
            })
          }
        />
      )}
    </Dialog>
  );
}

function MoveDialogBody({
  lang,
  folders,
  currentFolderId,
  disabledFolderIds,
  title,
  pending,
  onCancel,
  onMove,
}: {
  lang: string;
  folders: StorageFolder[];
  currentFolderId: string | null;
  disabledFolderIds: ReadonlySet<string>;
  title: string;
  pending: boolean;
  onCancel: () => void;
  onMove: (targetId: string | null) => void;
}) {
  const { t } = useTranslation(lang);
  const [target, setTarget] = useState<string | null>(currentFolderId);

  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{t("storage:moveDescription")}</DialogDescription>
      </DialogHeader>
      <FolderTreePicker
        lang={lang}
        folders={folders}
        value={target}
        onChange={setTarget}
        disabledFolderIds={disabledFolderIds}
        label={title}
      />
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={pending}
        >
          {t("cancel")}
        </Button>
        <Button
          type="button"
          disabled={pending || target === currentFolderId}
          onClick={() => onMove(target)}
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {t("storage:moveHere")}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
