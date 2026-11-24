"use client";

import Link from "next/link";
import { ArrowLeft, Check, ChevronDown, GitBranch, GitCommitHorizontal, Tag } from "lucide-react";
import type { GitRefList, GitRepositorySummary } from "@beutl/core";
import { cn } from "@beutl/core";
import { useTranslation } from "@beutl/ui/i18n-client";
import { Button } from "@beutl/ui/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@beutl/ui/ui/dropdown-menu";
import { OpenInBeutlButton } from "@/components/open-in-beutl-button";
import { repositoryHref, shortOid } from "./links";
import { PendingLink, useRepositoryNavigation } from "./navigation";

/**
 * What a revision names. `refs/heads/…` and `refs/tags/…` are exact; a short
 * name is a branch before a tag, as the repository resolves it.
 */
function describeRevision(revision: string | null, refs: GitRefList): { kind: "branch" | "tag" | "commit"; name: string } | null {
  if (revision === null) return null;
  if (revision.startsWith("refs/heads/")) return { kind: "branch", name: revision.slice("refs/heads/".length) };
  if (revision.startsWith("refs/tags/")) return { kind: "tag", name: revision.slice("refs/tags/".length) };
  if (refs.branches.some((ref) => ref.name === revision)) return { kind: "branch", name: revision };
  if (refs.tags.some((ref) => ref.name === revision)) return { kind: "tag", name: revision };
  return { kind: "commit", name: revision };
}

/** The repository's name, the version it shows, and its Files / Commits tabs. */
export function RepositoryHeader({
  lang,
  repository,
  refs,
  current,
  commit,
  tab,
}: {
  lang: string;
  repository: Pick<GitRepositorySummary, "id" | "name">;
  refs: GitRefList;
  /** A branch, a tag or a commit ID; null for a repository nothing was pushed to. */
  current: string | null;
  /** The commit the view resolved to, when there is one. */
  commit?: string;
  tab: "files" | "commits";
}) {
  const { t } = useTranslation(lang);
  const { navigate } = useRepositoryNavigation();
  const shown = describeRevision(current, refs);
  const CurrentIcon = shown?.kind === "tag" ? Tag : shown?.kind === "commit" ? GitCommitHorizontal : GitBranch;
  const switchTo = (ref: string) => navigate(repositoryHref(lang, repository.id, tab, { ref }));
  const tabLink = (target: "files" | "commits") => repositoryHref(lang, repository.id, target, { ref: current ?? undefined });

  return (
    <div className="flex flex-col gap-4">
      <Link prefetch={false}
        href={`/${lang}/dashboard/repositories`}
        className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        {t("dashboard:repositories.title")}
      </Link>
      <div className="grid min-w-0 items-start gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-primary/15 bg-primary/5 text-primary">
            <GitBranch className="size-5" aria-hidden />
          </span>
          <h1 className="min-w-0 break-words text-2xl font-semibold tracking-tight" title={repository.name}>{repository.name}</h1>
        </div>
        <OpenInBeutlButton
          lang={lang}
          repositoryId={repository.id}
          refName={current}
          className="font-semibold"
          containerClassName="sm:items-end sm:text-right"
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b pb-3">
        {current !== null && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="max-w-full gap-2 sm:max-w-64" aria-label={t("dashboard:repositories.browser.switchRef")}>
                <CurrentIcon className="size-4 shrink-0" aria-hidden />
                <span className="truncate">{shown?.kind === "commit" ? shortOid(shown.name) : shown?.name}</span>
                <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
              <DropdownMenuLabel>{t("dashboard:repositories.browser.branches")}</DropdownMenuLabel>
              {refs.branches.map((ref) => (
                <DropdownMenuItem key={ref.name} onSelect={() => switchTo(ref.name)}>
                  <Check className={cn("mr-2 size-4", !(shown?.kind === "branch" && shown.name === ref.name) && "invisible")} aria-hidden />
                  <span className="truncate">{ref.name}</span>
                </DropdownMenuItem>
              ))}
              {refs.tags.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>{t("dashboard:repositories.browser.tags")}</DropdownMenuLabel>
                  {refs.tags.map((ref) => (
                    <DropdownMenuItem key={ref.name} onSelect={() => switchTo(`refs/tags/${ref.name}`)}>
                      <Check className={cn("mr-2 size-4", !(shown?.kind === "tag" && shown.name === ref.name) && "invisible")} aria-hidden />
                      <span className="truncate">{ref.name}</span>
                    </DropdownMenuItem>
                  ))}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {commit && shown?.kind !== "commit" && (
          <span className="font-mono text-xs text-muted-foreground" title={commit}>{shortOid(commit)}</span>
        )}
        <nav className="flex gap-1 rounded-lg bg-muted/55 p-1 sm:ml-auto" aria-label={t("dashboard:repositories.browser.views")}>
          {(["files", "commits"] as const).map((target) => (
            <PendingLink
              key={target}
              href={tabLink(target)}
              aria-current={tab === target ? "page" : undefined}
              className={cn(
                "rounded-md px-3 py-1 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                tab === target ? "bg-background font-medium text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(`dashboard:repositories.browser.${target}`)}
            </PendingLink>
          ))}
        </nav>
      </div>
    </div>
  );
}
