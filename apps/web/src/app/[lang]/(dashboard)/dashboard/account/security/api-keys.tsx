"use client";

import { useState, useTransition } from "react";
import { KeyRound, Loader2, RefreshCw, Trash2 } from "lucide-react";
import type { ActionResult } from "@beutl/core";
import { useTranslation } from "@beutl/ui/i18n-client";
import { Badge } from "@beutl/ui/ui/badge";
import { Button } from "@beutl/ui/ui/button";
import { Separator } from "@beutl/ui/ui/separator";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@beutl/ui/ui/alert-dialog";
import { actionFailureKey } from "@/lib/action-error";
import { retrieveApiKeys, revokeApiKey } from "./api-key-actions";
import { ApiKeyDialog } from "./api-key-dialog";
import type { AccountApiKeys, ApiKeySummary } from "./api-key-types";

export function ApiKeys({ lang, initialResult, initialRepositoryId, nugetSource }: {
  lang: string; initialResult: ActionResult<AccountApiKeys>; initialRepositoryId?: string; nugetSource: string;
}) {
  const { t } = useTranslation(lang);
  const [result, setResult] = useState(initialResult);
  const data = result.success ? result.data : undefined;
  const selectedRepositoryId = data?.repositories.find((repository) => repository.id === initialRepositoryId)?.id;
  const [creating, setCreating] = useState(!!selectedRepositoryId);
  const [revoking, setRevoking] = useState<ApiKeySummary>();
  const [error, setError] = useState<string>();
  const [revokeError, setRevokeError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [pending, startTransition] = useTransition();
  const date = (value: string) => new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value));
  const failure = (error?: unknown) => t(actionFailureKey(error, "account:apiKeys.errors.requestFailed"));
  const refresh = () => startTransition(async () => {
    setError(undefined);
    try { setResult(await retrieveApiKeys()); }
    catch (error) { setError(failure(error)); }
  });
  const updateKeys = (update: (keys: ApiKeySummary[]) => ApiKeySummary[]) => setResult((previous) => previous.success && previous.data
    ? { success: true, data: { ...previous.data, keys: update(previous.data.keys) } } : previous);
  const revoke = () => {
    if (!revoking || pending) return;
    const key = revoking;
    startTransition(async () => {
      setRevokeError(undefined);
      try {
        const response = await revokeApiKey(key.kind === "nuget" ? { kind: key.kind, id: key.id }
          : { kind: key.kind, id: key.id, repositoryId: key.repositoryId });
        if (!response.success) { setRevokeError(response.message ?? failure()); return; }
        updateKeys((keys) => keys.filter((row) => row.kind !== key.kind || row.id !== key.id));
        setRevoking(undefined);
        setNotice(t("account:apiKeys.revoked"));
      } catch (error) { setRevokeError(failure(error)); }
    });
  };

  return <section id="api-keys" className="mt-4 scroll-mt-6 rounded-lg border text-card-foreground" aria-labelledby="api-keys-heading">
    <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
      <h3 id="api-keys-heading" className="font-bold text-md">{t("account:apiKeys.title")}</h3>
      <div className="flex items-center gap-2">
        <Button size="icon" variant="ghost" disabled={pending} aria-label={t("account:apiKeys.refresh")} onClick={refresh}><RefreshCw className={`size-4 ${pending ? "animate-spin" : ""}`} aria-hidden /></Button>
        <Button size="sm" disabled={pending || !data} onClick={() => { setNotice(undefined); setCreating(true); }}><KeyRound className="size-4" aria-hidden />{t("account:apiKeys.create")}</Button>
      </div>
    </div>
    <Separator />
    {!result.success && <p role="alert" className="px-6 py-4 text-sm text-destructive">{result.message ?? failure()}</p>}
    {data?.keys.length === 0 && <p className="px-6 py-4 text-sm text-muted-foreground">{t("account:apiKeys.empty")}</p>}
    {!!data?.keys.length && <ul className="divide-y">
      {data.keys.map((key) => <li key={`${key.kind}:${key.id}`} className="flex items-start gap-3 px-6 py-4">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="break-all text-sm font-medium">{key.name}</p>
            <code className="text-xs text-muted-foreground">…{key.hint}</code>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="secondary">{key.kind === "nuget" ? "NuGet" : t("account:apiKeys.repository")}</Badge>
            {key.kind === "repository" && <span className="break-all">{key.repositoryName}</span>}
            <span className="text-muted-foreground">{t(`account:apiKeys.${key.scope === "read" && key.kind === "nuget" ? "download" : key.scope}`)}</span>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{t("account:apiKeys.createdAt", { date: date(key.createdAt), interpolation: { escapeValue: false } })}</span>
            <span>{key.kind === "nuget" ? t("account:apiKeys.expiresAt", { date: date(key.expiresAt), interpolation: { escapeValue: false } }) : t("account:apiKeys.noExpiration")}</span>
            {key.kind === "repository" && <span>{key.lastUsedAt ? t("account:apiKeys.lastUsedAt", { date: date(key.lastUsedAt), interpolation: { escapeValue: false } }) : t("account:apiKeys.neverUsed")}</span>}
          </div>
        </div>
        <Button size="icon" variant="ghost" disabled={pending} aria-label={`${t("account:apiKeys.revoke")} ${key.name}`} onClick={() => { setRevokeError(undefined); setRevoking(key); }}><Trash2 className="size-4" aria-hidden /></Button>
      </li>)}
    </ul>}
    {notice && <p role="status" className="px-6 py-4 text-sm text-muted-foreground">{notice}</p>}
    {error && <p role="alert" className="px-6 py-4 text-sm text-destructive">{error}</p>}
    {creating && data && <ApiKeyDialog lang={lang} repositories={data.repositories} gitAvailable={data.gitAvailable} initialRepositoryId={selectedRepositoryId} nugetSource={nugetSource}
      onCreated={(key) => updateKeys((keys) => [key, ...keys.filter((row) => row.kind !== key.kind || row.id !== key.id)])} onClose={() => setCreating(false)} />}
    <AlertDialog open={!!revoking} onOpenChange={(open) => { if (!open && !pending) setRevoking(undefined); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-all">{t("account:apiKeys.confirmRevoke", { name: revoking?.name, interpolation: { escapeValue: false } })}</AlertDialogTitle>
          <AlertDialogDescription>{t("account:apiKeys.revokeDescription")}</AlertDialogDescription>
        </AlertDialogHeader>
        {revokeError && <p role="alert" className="text-sm text-destructive">{revokeError}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" disabled={pending} onClick={(event) => { event.preventDefault(); revoke(); }}>
            {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}{t("account:apiKeys.revoke")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section>;
}
