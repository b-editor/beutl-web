"use client";

import { Loader2 } from "lucide-react";
import {
  type FormEvent,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { Button } from "@beutl/ui/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@beutl/ui/ui/dialog";
import { Input } from "@beutl/ui/ui/input";
import { Label } from "@beutl/ui/ui/label";
import { STORAGE_FILE_NAME_MAX_LENGTH } from "@beutl/core";
import { useTranslation } from "@beutl/ui/i18n-client";
import { isValidStorageName } from "./names";

// One dialog for every "give it a name" moment: renaming a file or folder and
// creating a folder. The caller owns the request; this only validates and
// closes on success.
export function NameDialog({
  open,
  onOpenChange,
  lang,
  title,
  description,
  label,
  initialName,
  submitLabel,
  selectStem = false,
  allowUnchanged = false,
  invalidMessage,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lang: string;
  title: string;
  description: string;
  label: string;
  initialName: string;
  submitLabel: string;
  // Preselect the part before the extension, so typing replaces the stem.
  selectStem?: boolean;
  allowUnchanged?: boolean;
  invalidMessage: string;
  onSubmit: (name: string) => Promise<boolean>;
}) {
  const { t } = useTranslation(lang);
  const [name, setName] = useState(initialName);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) setName(initialName);
  }, [open, initialName]);

  const trimmed = name.trim();
  const valid = isValidStorageName(trimmed);
  const unchanged = !allowUnchanged && trimmed === initialName.trim();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || unchanged || pending) return;
    startTransition(async () => {
      const ok = await onSubmit(trimmed);
      if (ok) onOpenChange(false);
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const input = inputRef.current;
          if (!input) return;
          input.focus();
          const dot = selectStem ? initialName.lastIndexOf(".") : -1;
          input.setSelectionRange(0, dot > 0 ? dot : initialName.length);
        }}
      >
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="storage-name-input">{label}</Label>
            <Input
              id="storage-name-input"
              ref={inputRef}
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={STORAGE_FILE_NAME_MAX_LENGTH}
              aria-invalid={name.length > 0 && !valid}
              autoComplete="off"
              spellCheck={false}
            />
            {name.length > 0 && !valid && (
              <p className="text-xs text-destructive">{invalidMessage}</p>
            )}
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
            <Button type="submit" disabled={!valid || unchanged || pending}>
              {pending && (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              )}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
