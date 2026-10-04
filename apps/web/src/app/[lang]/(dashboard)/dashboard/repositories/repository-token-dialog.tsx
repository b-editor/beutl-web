"use client";

import { useState, useTransition } from "react";
import { Copy, KeyRound, Loader2, Terminal } from "lucide-react";
import type { GitRepositorySummary, GitRepositoryToken } from "@beutl/core";
import { useTranslation } from "@beutl/ui/i18n-client";
import { Button } from "@beutl/ui/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@beutl/ui/ui/dialog";
import { Input } from "@beutl/ui/ui/input";
import { Label } from "@beutl/ui/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@beutl/ui/ui/select";
import { createRepositoryToken } from "./actions";
import { repositoryCloneCommand } from "./connection";

export function RepositoryTokenDialog({ repository, lang, onClose }: {
  repository: GitRepositorySummary; lang: string; onClose: () => void;
}) {
  const { t } = useTranslation(lang);
  const [scope, setScope] = useState<"read" | "write">("read");
  const [credential, setCredential] = useState<GitRepositoryToken>();
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();
  const generate = () => startTransition(async () => {
    setError(undefined); setCopied(false); setCredential(undefined);
    try {
      const result = await createRepositoryToken(repository.id, scope);
      if (result.success && result.data) setCredential(result.data);
      else setError(result.message ?? t("dashboard:repositories.errors.requestFailed"));
    } catch { setError(t("dashboard:repositories.errors.requestFailed")); }
  });
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setError(undefined); }
    catch { setError(t("dashboard:repositories.copyFailed")); }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader className="text-left">
          <DialogTitle>{t("dashboard:repositories.connect")}</DialogTitle>
          <DialogDescription className="break-all">{repository.name}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="repository-clone-url">{t("dashboard:repositories.cloneUrl")}</Label>
            <div className="flex gap-2">
              <Input id="repository-clone-url" readOnly value={repository.url} className="min-w-0 bg-muted/20 font-mono text-xs" onFocus={(event) => event.target.select()} />
              <Button variant="outline" size="icon" aria-label={t("dashboard:repositories.copyUrl")} onClick={() => copy(repository.url)}><Copy className="size-4" aria-hidden /></Button>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="repository-token-scope">{t("dashboard:repositories.tokenScope")}</Label>
            <Select value={scope} disabled={pending} onValueChange={(value) => {
              setScope(value as "read" | "write"); setCredential(undefined); setCopied(false); setError(undefined);
            }}>
              <SelectTrigger id="repository-token-scope" className="w-full [&>span]:truncate"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="read">{t("dashboard:repositories.read")}</SelectItem>
                <SelectItem value="write">{t("dashboard:repositories.write")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button variant={credential ? "ghost" : "default"} onClick={generate} disabled={pending}>
            {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <KeyRound className="size-4" aria-hidden />}
            {t(`dashboard:repositories.${credential ? "regenerateToken" : "generateToken"}`)}
          </Button>
          {credential && <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-4">
            <Label htmlFor="repository-token">{t("dashboard:repositories.token")}</Label>
            <div className="flex gap-2">
              <Input id="repository-token" type="password" autoComplete="off" readOnly value={credential.token} className="min-w-0 font-mono" />
              <Button variant="outline" size="icon" aria-label={t("dashboard:repositories.copyToken")} onClick={() => copy(credential.token)}><Copy className="size-4" aria-hidden /></Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("dashboard:repositories.tokenExpires", {
              interpolation: { escapeValue: false },
              date: new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(credential.expiresAt)),
            })}</p>
            <Button onClick={() => copy(repositoryCloneCommand(repository.url, credential.token))}>
              <Terminal className="size-4" aria-hidden />{t("dashboard:repositories.copyCloneCommand")}
            </Button>
          </div>}
          {copied && <p role="status" className="text-sm text-muted-foreground">{t("dashboard:repositories.copied")}</p>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter><Button variant="outline" disabled={pending} onClick={onClose}>{t("dashboard:repositories.close")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
