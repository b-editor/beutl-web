"use client";

import { useState, useTransition, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { GIT_REPOSITORY_NAME_MAX_LENGTH, isValidGitRepositoryName } from "@beutl/core";
import { useTranslation } from "@beutl/ui/i18n-client";
import { Button } from "@beutl/ui/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@beutl/ui/ui/dialog";
import { Input } from "@beutl/ui/ui/input";
import { Label } from "@beutl/ui/ui/label";

export function RepositoryNameDialog({ lang, initialName, onClose, onSubmit }: {
  lang: string;
  initialName?: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<string | undefined>;
}) {
  const { t } = useTranslation(lang);
  const [name, setName] = useState(initialName ?? "");
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const valid = isValidGitRepositoryName(name);
  const unchanged = initialName !== undefined && name.trim() === initialName;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || unchanged || pending) return;
    startTransition(async () => {
      try { setError(await onSubmit(name.trim())); }
      catch { setError(t("dashboard:repositories.errors.requestFailed")); }
    });
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader className="text-left">
            <DialogTitle>{t(`dashboard:repositories.${initialName === undefined ? "createTitle" : "rename"}`)}</DialogTitle>
            <DialogDescription className="sr-only">{t("dashboard:repositories.nameDescription", { max: GIT_REPOSITORY_NAME_MAX_LENGTH })}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="repository-name">{t("dashboard:repositories.name")}</Label>
            <Input id="repository-name" value={name} maxLength={GIT_REPOSITORY_NAME_MAX_LENGTH}
              onChange={(event) => { setName(event.target.value); setError(undefined); }}
              autoComplete="off" spellCheck={false} disabled={pending}
              aria-invalid={name.length > 0 && !valid} aria-describedby={name.length > 0 && !valid ? "repository-name-help" : undefined} />
            {name.length > 0 && !valid && <p id="repository-name-help" className="text-xs text-destructive">
              {t("dashboard:repositories.errors.invalidName")}
            </p>}
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>{t("cancel")}</Button>
            <Button type="submit" disabled={!valid || unchanged || pending}>
              {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {t(initialName === undefined ? "dashboard:repositories.createSubmit" : "save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
