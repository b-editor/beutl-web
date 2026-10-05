"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Copy, FolderOpen, GitBranch, KeyRound, LockKeyhole, MoreVertical, Pencil, Trash2 } from "lucide-react";
import type { GitRepositorySummary } from "@beutl/core";
import { useTranslation } from "@beutl/ui/i18n-client";
import { Button } from "@beutl/ui/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@beutl/ui/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@beutl/ui/ui/dropdown-menu";

export type RepositoryHandlers = {
  connect: (repository: GitRepositorySummary) => void;
  copyUrl: (repository: GitRepositorySummary) => void;
  rename: (repository: GitRepositorySummary) => void;
  delete: (repository: GitRepositorySummary) => void;
};

type ItemProps = {
  repository: GitRepositorySummary;
  lang: string;
  disabled: boolean;
  copied: boolean;
  handlers: RepositoryHandlers;
};

/** Where a repository's files are browsed. */
export const repositoryPageHref = (lang: string, repository: Pick<GitRepositorySummary, "id">) =>
  `/${lang}/dashboard/repositories/${repository.id}`;

function MenuItems({ repository, lang, disabled, copied, handlers, context = false }: ItemProps & { context?: boolean }) {
  const { t } = useTranslation(lang);
  const router = useRouter();
  const Item = context ? ContextMenuItem : DropdownMenuItem;
  const Separator = context ? ContextMenuSeparator : DropdownMenuSeparator;
  return <>
    <Item disabled={disabled} onSelect={() => router.push(repositoryPageHref(lang, repository))}><FolderOpen className="mr-2 size-4" aria-hidden />{t("dashboard:repositories.browse")}</Item>
    <Item disabled={disabled} onSelect={() => handlers.connect(repository)}><KeyRound className="mr-2 size-4" aria-hidden />{t("dashboard:repositories.connect")}</Item>
    <Item onSelect={() => handlers.copyUrl(repository)}>{copied ? <Check className="mr-2 size-4" aria-hidden /> : <Copy className="mr-2 size-4" aria-hidden />}{t("dashboard:repositories.copyUrl")}</Item>
    <Item disabled={disabled} onSelect={() => handlers.rename(repository)}><Pencil className="mr-2 size-4" aria-hidden />{t("dashboard:repositories.rename")}</Item>
    <Separator />
    <Item disabled={disabled} className="text-destructive focus:text-destructive" onSelect={() => handlers.delete(repository)}><Trash2 className="mr-2 size-4" aria-hidden />{t("dashboard:repositories.delete")}</Item>
  </>;
}

export function RepositoryActions(props: ItemProps) {
  const { t } = useTranslation(props.lang);
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant="ghost" size="icon" className="size-8" aria-label={t("storage:actionsFor", { name: props.repository.name, interpolation: { escapeValue: false } })}>
        <MoreVertical className="size-4" aria-hidden />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end"><MenuItems {...props} /></DropdownMenuContent>
  </DropdownMenu>;
}

export function RepositoryContextMenu({ children, ...props }: ItemProps & { children: ReactNode }) {
  return <ContextMenu>
    <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
    <ContextMenuContent><MenuItems {...props} context /></ContextMenuContent>
  </ContextMenu>;
}

export function RepositoryVisibility({ lang }: { lang: string }) {
  const { t } = useTranslation(lang);
  return <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><LockKeyhole className="size-3" aria-hidden />{t("dashboard:repositories.private")}</span>;
}

export function RepositoryDate({ repository, lang }: Pick<ItemProps, "repository" | "lang">) {
  return <time dateTime={repository.createdAt} className="text-xs tabular-nums text-muted-foreground">
    {new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(repository.createdAt))}
  </time>;
}

export function RepositoryGridCard(props: ItemProps) {
  const { repository, handlers, disabled, lang } = props;
  const { t } = useTranslation(lang);
  return <RepositoryContextMenu {...props}>
    <div className="group flex min-w-0 flex-col overflow-hidden rounded-lg border bg-card text-card-foreground transition-colors hover:bg-accent/40">
      <Link prefetch={false} className="flex aspect-[4/3] w-full items-center justify-center bg-muted/40 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-disabled:pointer-events-none aria-disabled:opacity-50" aria-disabled={disabled} tabIndex={disabled ? -1 : undefined} href={repositoryPageHref(lang, repository)} aria-label={`${t("dashboard:repositories.browse")} ${repository.name}`}>
        <GitBranch className="size-10 text-muted-foreground" aria-hidden />
      </Link>
      <div className="flex items-center gap-2 px-3 py-2">
        <GitBranch className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium" title={repository.name}>
          <Link prefetch={false} className="block w-full truncate text-left outline-none hover:underline focus-visible:underline aria-disabled:pointer-events-none aria-disabled:opacity-50" aria-disabled={disabled} tabIndex={disabled ? -1 : undefined} href={repositoryPageHref(lang, repository)}>{repository.name}</Link>
        </h2>
        <RepositoryActions {...props} />
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-2.5">
        <RepositoryVisibility lang={lang} />
        <RepositoryDate repository={repository} lang={lang} />
      </div>
    </div>
  </RepositoryContextMenu>;
}
