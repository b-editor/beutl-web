"use client";

import { useState, useTransition, type FormEvent } from "react";
import { KeyRound, Loader2, Terminal } from "lucide-react";
import { isValidGitAccessTokenName, NUGET_SERVICE_INDEX } from "@beutl/core";
import { useTranslation } from "@beutl/ui/i18n-client";
import { Button } from "@beutl/ui/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@beutl/ui/ui/dialog";
import { Input } from "@beutl/ui/ui/input";
import { Label } from "@beutl/ui/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@beutl/ui/ui/select";
import { actionFailureKey } from "@/lib/action-error";
import { CopyableInput } from "@/components/copyable-input";
import { authenticatedCloneUrl, repositoryCloneCommand } from "../../repositories/connection";
import { createApiKey } from "./api-key-actions";
import type { AccountApiKeys, ApiKeySettings, ApiKeySummary, CreatedApiKey } from "./api-key-types";

export function ApiKeyDialog({ lang, repositories, gitAvailable, initialRepositoryId, onCreated, onClose }: {
  lang: string;
  repositories: AccountApiKeys["repositories"];
  gitAvailable: boolean;
  initialRepositoryId?: string;
  onCreated: (key: ApiKeySummary) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(lang);
  const [kind, setKind] = useState<ApiKeySettings["kind"]>(initialRepositoryId ? "repository" : "nuget");
  const [repositoryId, setRepositoryId] = useState(initialRepositoryId ?? repositories[0]?.id ?? "");
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"read" | "push" | "write">("read");
  const [days, setDays] = useState("90");
  const [created, setCreated] = useState<CreatedApiKey>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [pending, startTransition] = useTransition();
  const validName = kind === "repository" ? isValidGitAccessTokenName(name)
    : !!name.trim() && name.length <= 100 && !/\p{Cc}/u.test(name);
  const canCreate = validName && (kind === "nuget" || (gitAvailable && !!repositoryId));
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setNotice(t("account:apiKeys.copied")); setError(undefined); }
    catch {
      // Clipboard permission failures use the localized message without exposing the key.
      setError(t("account:apiKeys.copyFailed"));
    }
  };
  const create = (event: FormEvent) => {
    event.preventDefault();
    if (pending || !canCreate) return;
    startTransition(async () => {
      setError(undefined);
      try {
        const input: ApiKeySettings = kind === "nuget"
          ? { kind, name, scope: scope === "push" ? "push" : "read", days: Number(days) }
          : { kind, name, scope: scope === "write" ? "write" : "read", repositoryId };
        const result = await createApiKey(input);
        if (!result.success || !result.data) { setError(result.message ?? t("account:apiKeys.errors.requestFailed")); return; }
        setCreated(result.data);
        onCreated(result.data.key);
      } catch (error) { setError(t(actionFailureKey(error, "account:apiKeys.errors.requestFailed"))); }
    });
  };

  return <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
    <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto" aria-describedby={created ? "api-key-secret-notice" : undefined}>
      <DialogHeader className="text-left">
        <DialogTitle>{t(created ? "account:apiKeys.created" : "account:apiKeys.create")}</DialogTitle>
        {created && <DialogDescription id="api-key-secret-notice">{t("account:apiKeys.secretNotice")}</DialogDescription>}
      </DialogHeader>
      {created ? <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="api-key-secret">{t("account:apiKeys.key")}</Label>
          <CopyableInput id="api-key-secret" secret value={created.secret} className="text-xs"
            copyLabel={t("account:apiKeys.copyKey")} onCopy={copy} />
        </div>
        {created.cloneUrl && <>
          <div className="space-y-2">
            <Label htmlFor="api-key-clone-url">{t("account:apiKeys.authenticatedCloneUrl")}</Label>
            <CopyableInput id="api-key-clone-url" secret value={authenticatedCloneUrl(created.cloneUrl, created.secret)} className="text-xs"
              copyLabel={t("account:apiKeys.copyUrl")} onCopy={copy} />
          </div>
          <Button variant="outline" onClick={() => copy(repositoryCloneCommand(created.cloneUrl!, created.secret))}><Terminal className="size-4" aria-hidden />{t("account:apiKeys.copyCloneCommand")}</Button>
        </>}
        {created.key.kind === "nuget" && <div className="space-y-2">
          <Label htmlFor="api-key-nuget-source">{t("account:apiKeys.nugetSource")}</Label>
          <CopyableInput id="api-key-nuget-source" value={NUGET_SERVICE_INDEX} className="text-xs"
            copyLabel={t("account:apiKeys.copyUrl")} onCopy={copy} />
        </div>}
      </div> : <form id="create-api-key" onSubmit={create} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="api-key-name">{t("account:apiKeys.name")}</Label>
          <Input id="api-key-name" value={name} required maxLength={kind === "repository" ? 80 : 100} disabled={pending} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="api-key-kind">{t("account:apiKeys.service")}</Label>
          <Select value={kind} disabled={pending} onValueChange={(value) => { setKind(value as ApiKeySettings["kind"]); setScope("read"); setError(undefined); }}>
            <SelectTrigger id="api-key-kind" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="nuget">NuGet</SelectItem><SelectItem value="repository">{t("account:apiKeys.repository")}</SelectItem></SelectContent>
          </Select>
        </div>
        {kind === "repository" && <div className="space-y-2">
          <Label htmlFor="api-key-repository">{t("account:apiKeys.repository")}</Label>
          <Select value={repositoryId} disabled={pending || !gitAvailable || !repositories.length} onValueChange={setRepositoryId}>
            <SelectTrigger id="api-key-repository" className="w-full [&>span]:truncate"><SelectValue placeholder={t("account:apiKeys.noRepositories")} /></SelectTrigger>
            <SelectContent>{repositories.map((repository) => <SelectItem key={repository.id} value={repository.id}>{repository.name}</SelectItem>)}</SelectContent>
          </Select>
          {!gitAvailable && <p role="alert" className="text-sm text-destructive">{t("account:apiKeys.errors.gitUnavailable")}</p>}
        </div>}
        <div className="space-y-2">
          <Label htmlFor="api-key-scope">{t("account:apiKeys.permissions")}</Label>
          <Select value={scope} disabled={pending} onValueChange={(value) => setScope(value as typeof scope)}>
            <SelectTrigger id="api-key-scope" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="read">{t(kind === "nuget" ? "account:apiKeys.download" : "account:apiKeys.read")}</SelectItem>
              {kind === "nuget" ? <SelectItem value="push">{t("account:apiKeys.push")}</SelectItem> : <SelectItem value="write">{t("account:apiKeys.write")}</SelectItem>}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="api-key-expiry">{t("account:apiKeys.expiration")}</Label>
          {kind === "nuget" ? <Select value={days} disabled={pending} onValueChange={setDays}>
            <SelectTrigger id="api-key-expiry" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{[7, 30, 90, 365].map((value) => <SelectItem key={value} value={String(value)}>{t("account:apiKeys.days", { count: value })}</SelectItem>)}</SelectContent>
          </Select> : <Input id="api-key-expiry" readOnly value={t("account:apiKeys.noExpiration")} />}
        </div>
      </form>}
      {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter>
        <Button variant="outline" disabled={pending} onClick={onClose}>{t(created ? "account:apiKeys.close" : "cancel")}</Button>
        {!created && <Button type="submit" form="create-api-key" disabled={pending || !canCreate}>
          {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <KeyRound className="size-4" aria-hidden />}{t("account:apiKeys.create")}
        </Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
