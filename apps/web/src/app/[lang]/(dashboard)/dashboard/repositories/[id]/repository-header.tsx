"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
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
import { repositoryHref, shortOid } from "./links";

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
  const router = useRouter();
  const isTag = current !== null && !refs.branches.some((ref) => ref.name === current) && refs.tags.some((ref) => ref.name === current);
  const isCommit = current !== null && !isTag && !refs.branches.some((ref) => ref.name === current);
  const CurrentIcon = isTag ? Tag : isCommit ? GitCommitHorizontal : GitBranch;
  const switchTo = (ref: string) => router.push(repositoryHref(lang, repository.id, tab, { ref }));
  const tabLink = (target: "files" | "commits") => repositoryHref(lang, repository.id, target, { ref: current ?? undefined });

  return (
    <div className="flex flex-col gap-3">
      <Link prefetch={false}
        href={`/${lang}/dashboard/repositories`}
        className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        {t("dashboard:repositories.title")}
      </Link>
      <div className="flex min-w-0 items-center gap-2">
        <GitBranch className="size-6 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="truncate text-2xl font-bold" title={repository.name}>{repository.name}</h1>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {current !== null && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="max-w-64 gap-2" aria-label={t("dashboard:repositories.browser.switchRef")}>
                <CurrentIcon className="size-4 shrink-0" aria-hidden />
                <span className="truncate">{isCommit ? shortOid(current) : current}</span>
                <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
              <DropdownMenuLabel>{t("dashboard:repositories.browser.branches")}</DropdownMenuLabel>
              {refs.branches.map((ref) => (
                <DropdownMenuItem key={ref.name} onSelect={() => switchTo(ref.name)}>
                  <Check className={cn("mr-2 size-4", ref.name !== current && "invisible")} aria-hidden />
                  <span className="truncate">{ref.name}</span>
                </DropdownMenuItem>
              ))}
              {refs.tags.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>{t("dashboard:repositories.browser.tags")}</DropdownMenuLabel>
                  {refs.tags.map((ref) => (
                    <DropdownMenuItem key={ref.name} onSelect={() => switchTo(ref.name)}>
                      <Check className={cn("mr-2 size-4", ref.name !== current && "invisible")} aria-hidden />
                      <span className="truncate">{ref.name}</span>
                    </DropdownMenuItem>
                  ))}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {commit && !isCommit && (
          <span className="font-mono text-xs text-muted-foreground" title={commit}>{shortOid(commit)}</span>
        )}
        <nav className="ml-auto flex rounded-md border p-0.5" aria-label={t("dashboard:repositories.browser.views")}>
          {(["files", "commits"] as const).map((target) => (
            <Link prefetch={false}
              key={target}
              href={tabLink(target)}
              aria-current={tab === target ? "page" : undefined}
              className={cn(
                "rounded-sm px-3 py-1 text-sm transition-colors",
                tab === target ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(`dashboard:repositories.browser.${target}`)}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
