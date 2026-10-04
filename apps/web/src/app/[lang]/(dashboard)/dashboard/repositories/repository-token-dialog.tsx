"use client";

import { useEffect, useState, useTransition, type FormEvent } from "react";
import { Copy, KeyRound, Loader2, Terminal, Trash2 } from "lucide-react";
import {
  isValidGitAccessTokenName,
  type CreatedGitAccessToken,
  type GitAccessTokenScope,
  type GitAccessTokenSummary,
  type GitRepositorySummary,
} from "@beutl/core";
import { useTranslation } from "@beutl/ui/i18n-client";
import { Button } from "@beutl/ui/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@beutl/ui/ui/dialog";
import { Input } from "@beutl/ui/ui/input";
import { Label } from "@beutl/ui/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@beutl/ui/ui/select";
import { createRepositoryToken, listRepositoryTokens, revokeRepositoryToken } from "./actions";
import { authenticatedCloneUrl, repositoryCloneCommand } from "./connection";

export function RepositoryTokenDialog({ repository, lang, onClose }: {
  repository: GitRepositorySummary; lang: string; onClose: () => void;
}) {
  const { t } = useTranslation(lang);
  const [tokens, setTokens] = useState<GitAccessTokenSummary[]>();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<GitAccessTokenScope>("read");
  const [created, setCreated] = useState<CreatedGitAccessToken>();
  const [revoking, setRevoking] = useState<GitAccessTokenSummary>();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const failure = () => t("dashboard:repositories.errors.requestFailed");
  const date = (value: string) =>
    new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value));

  const run = (work: () => Promise<void>) => startTransition(async () => {
    setError(undefined); setNotice(undefined);
    try { await work(); }
    catch {
      // The action could not be reached; the server logs its own failures.
      setError(failure());
    }
  });
  useEffect(() => {
    run(async () => {
      const result = await listRepositoryTokens(repository.id);
      if (result.success) setTokens(result.data ?? []);
      else setError(result.message ?? failure());
    });
    // Load once per repository; run only wraps the transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repository.id]);

  const create = (event: FormEvent) => {
    event.preventDefault();
    if (!isValidGitAccessTokenName(name) || pending) return;
    run(async () => {
      setCreated(undefined);
      const result = await createRepositoryToken(repository.id, name.trim(), scope);
      if (!result.success || !result.data) { setError(result.message ?? failure()); return; }
      const { id, name: tokenName, scope: tokenScope, hint, createdAt, lastUsedAt } = result.data;
      setCreated(result.data);
      // The list keeps the summary only; the secret stays in the one-time panel.
      setTokens((rows) => [{ id, name: tokenName, scope: tokenScope, hint, createdAt, lastUsedAt }, ...(rows ?? [])]);
      setName("");
    });
  };
  const revoke = (token: GitAccessTokenSummary) => run(async () => {
    const result = await revokeRepositoryToken(repository.id, token.id);
    if (!result.success) { setError(result.message ?? failure()); return; }
    setTokens((rows) => rows?.filter((row) => row.id !== token.id));
    if (created?.id === token.id) setCreated(undefined);
    setRevoking(undefined);
    setNotice(t("dashboard:repositories.tokenRevoked"));
  });
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setNotice(t("dashboard:repositories.copied")); setError(undefined); }
    catch {
      // Clipboard permission is the browser's decision; report that copying failed.
      setError(t("dashboard:repositories.copyFailed"));
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader className="text-left">
          <DialogTitle>{t("dashboard:repositories.connect")}</DialogTitle>
          <DialogDescription className="break-all">{repository.name}</DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex flex-col gap-2">
            <Label htmlFor="repository-clone-url">{t("dashboard:repositories.cloneUrl")}</Label>
            <div className="flex gap-2">
              <Input id="repository-clone-url" readOnly value={repository.url} className="min-w-0 bg-muted/20 font-mono text-xs" onFocus={(event) => event.target.select()} />
              <Button variant="outline" size="icon" aria-label={t("dashboard:repositories.copyUrl")} onClick={() => copy(repository.url)}><Copy className="size-4" aria-hidden /></Button>
            </div>
          </div>

          <section className="flex flex-col gap-3" aria-labelledby="repository-tokens-heading">
            <div className="flex flex-col gap-1">
              <h3 id="repository-tokens-heading" className="text-sm font-medium">{t("dashboard:repositories.tokens")}</h3>
              <p className="text-xs text-muted-foreground">{t("dashboard:repositories.tokensDescription")}</p>
            </div>
            <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={create}>
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <Label htmlFor="repository-token-name">{t("dashboard:repositories.tokenName")}</Label>
                <Input id="repository-token-name" value={name} maxLength={80} disabled={pending}
                  placeholder={t("dashboard:repositories.tokenNamePlaceholder")} onChange={(event) => setName(event.target.value)} />
              </div>
              <div className="flex flex-col gap-2 sm:w-44">
                <Label htmlFor="repository-token-scope">{t("dashboard:repositories.tokenScope")}</Label>
                <Select value={scope} disabled={pending} onValueChange={(value) => setScope(value as GitAccessTokenScope)}>
                  <SelectTrigger id="repository-token-scope" className="w-full [&>span]:truncate"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="read">{t("dashboard:repositories.read")}</SelectItem>
                    <SelectItem value="write">{t("dashboard:repositories.write")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" disabled={pending || !isValidGitAccessTokenName(name)}>
                {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <KeyRound className="size-4" aria-hidden />}
                {t("dashboard:repositories.createToken")}
              </Button>
            </form>

            {created && <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-4">
              <p className="text-sm font-medium">{t("dashboard:repositories.newTokenNotice")}</p>
              <Label htmlFor="repository-token">{t("dashboard:repositories.token")}</Label>
              <div className="flex gap-2">
                <Input id="repository-token" type="password" autoComplete="off" readOnly value={created.token} className="min-w-0 font-mono" />
                <Button variant="outline" size="icon" aria-label={t("dashboard:repositories.copyToken")} onClick={() => copy(created.token)}><Copy className="size-4" aria-hidden /></Button>
              </div>
              <Label htmlFor="repository-authenticated-url">{t("dashboard:repositories.authenticatedCloneUrl")}</Label>
              <div className="flex gap-2">
                <Input id="repository-authenticated-url" type="password" autoComplete="off" readOnly value={authenticatedCloneUrl(repository.url, created.token)} className="min-w-0 font-mono text-xs" />
                <Button variant="outline" size="icon" aria-label={t("dashboard:repositories.copyUrl")} onClick={() => copy(authenticatedCloneUrl(repository.url, created.token))}><Copy className="size-4" aria-hidden /></Button>
              </div>
              <Button onClick={() => copy(repositoryCloneCommand(repository.url, created.token))}>
                <Terminal className="size-4" aria-hidden />{t("dashboard:repositories.copyCloneCommand")}
              </Button>
            </div>}

            {tokens === undefined
              ? <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
              : tokens.length === 0
                ? <p className="text-sm text-muted-foreground">{t("dashboard:repositories.noTokens")}</p>
                : <ul className="divide-y rounded-lg border">
                  {tokens.map((token) => <li key={token.id} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{token.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {t(`dashboard:repositories.${token.scope}`)} · …{token.hint} · {t("dashboard:repositories.tokenCreatedAt", { date: date(token.createdAt) })} · {token.lastUsedAt
                          ? t("dashboard:repositories.tokenLastUsed", { date: date(token.lastUsedAt) })
                          : t("dashboard:repositories.tokenNeverUsed")}
                      </p>
                    </div>
                    {revoking?.id === token.id
                      ? <div className="flex shrink-0 gap-2">
                        <Button size="sm" variant="destructive" disabled={pending} onClick={() => revoke(token)}>{t("dashboard:repositories.revokeToken")}</Button>
                        <Button size="sm" variant="outline" disabled={pending} onClick={() => setRevoking(undefined)}>{t("cancel")}</Button>
                      </div>
                      : <Button size="icon" variant="ghost" disabled={pending} aria-label={`${t("dashboard:repositories.revokeToken")} ${token.name}`} onClick={() => setRevoking(token)}><Trash2 className="size-4" aria-hidden /></Button>}
                  </li>)}
                </ul>}
            {revoking && <p className="text-sm text-muted-foreground">{t("dashboard:repositories.confirmRevokeToken", { name: revoking.name, interpolation: { escapeValue: false } })}</p>}
          </section>
          {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter><Button variant="outline" disabled={pending} onClick={onClose}>{t("dashboard:repositories.close")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
