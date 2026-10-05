"use client";

import { useState, useSyncExternalStore, useTransition } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, GitBranch, LayoutGrid, List as ListIcon, Loader2, Plus, RefreshCw, Search, X } from "lucide-react";
import { GIT_REPOSITORY_LIMIT, type ActionResult, type GitRepositorySummary } from "@beutl/core";
import { useTranslation } from "@beutl/ui/i18n-client";
import { Button } from "@beutl/ui/ui/button";
import { Badge } from "@beutl/ui/ui/badge";
import { Input } from "@beutl/ui/ui/input";
import { Label } from "@beutl/ui/ui/label";
import { Alert, AlertDescription } from "@beutl/ui/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@beutl/ui/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@beutl/ui/ui/dropdown-menu";
import { createRepository, deleteRepository, renameRepository, retrieveRepositories } from "./actions";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@beutl/ui/ui/tooltip";
import { RepositoryNameDialog } from "./repository-name-dialog";
import { RepositoryTokenDialog } from "./repository-token-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beutl/ui/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@beutl/ui/ui/toggle-group";
import { RepositoryActions, RepositoryContextMenu, RepositoryDate, RepositoryGridCard, RepositoryVisibility, repositoryPageHref, type RepositoryHandlers } from "./repository-items";
import Link from "next/link";

type ViewMode = "grid" | "list";
type SortField = "name" | "createdAt";
const VIEW_STORAGE_KEY = "beutl.repositories.view";

function storedView(): ViewMode {
  try { return localStorage.getItem(VIEW_STORAGE_KEY) === "list" ? "list" : "grid"; }
  catch {
    // Storage can be blocked by the browser; the default view still works.
    return "grid";
  }
}

function subscribeView(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

export function RepositoryManager({ lang, userId, initialResult }: {
  lang: string; userId: string; initialResult: ActionResult<GitRepositorySummary[]>;
}) {
  const { t } = useTranslation(lang);
  const [repositories, setRepositories] = useState(initialResult.success ? initialResult.data ?? [] : []);
  const [available, setAvailable] = useState(initialResult.success);
  const [error, setError] = useState(initialResult.success ? undefined : initialResult.message);
  const [notice, setNotice] = useState<string>();
  const [copiedUrl, setCopiedUrl] = useState<string>();
  const [query, setQuery] = useState("");
  const savedView = useSyncExternalStore(subscribeView, storedView, () => "grid" as const);
  const [selectedView, setSelectedView] = useState<ViewMode>();
  const view = selectedView ?? savedView;
  const [sort, setSort] = useState<{ field: SortField; descending: boolean }>({ field: "createdAt", descending: true });
  const changeView = (value: string) => {
    if (value !== "grid" && value !== "list") return;
    setSelectedView(value);
    try { localStorage.setItem(VIEW_STORAGE_KEY, value); } catch { /* Keep the current view usable. */ }
  };
  const [editing, setEditing] = useState<{ repository?: GitRepositorySummary; creationId?: string }>();
  const [deleting, setDeleting] = useState<GitRepositorySummary>();
  const [confirmation, setConfirmation] = useState("");
  const [deleteError, setDeleteError] = useState<string>();
  const [connecting, setConnecting] = useState<GitRepositorySummary>();
  const [pending, startTransition] = useTransition();
  const failure = () => t("dashboard:repositories.errors.requestFailed");
  const create = () => setEditing({ creationId: crypto.randomUUID() });
  const refresh = () => startTransition(async () => {
    setNotice(undefined);
    try {
      const result = await retrieveRepositories();
      setAvailable(result.success);
      if (result.success) { setRepositories(result.data ?? []); setError(undefined); }
      else setError(result.message ?? failure());
    } catch {
      // The action could not be reached; the server logs its own failures.
      setAvailable(false); setError(failure());
    }
  });
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setNotice(t("dashboard:repositories.copied")); setCopiedUrl(value); }
    catch {
      // Clipboard permission is the browser's decision; report that copying failed.
      setError(t("dashboard:repositories.copyFailed"));
    }
  };
  const remove = () => {
    if (!deleting || confirmation !== deleting.name || pending) return;
    const repository = deleting;
    startTransition(async () => {
      try {
        const result = await deleteRepository(repository.id);
        if (!result.success) { setDeleteError(result.message ?? failure()); return; }
        setRepositories((rows) => rows.filter((row) => row.id !== repository.id));
        setDeleting(undefined); setError(undefined);
        setNotice(t("dashboard:repositories.deleted"));
      } catch {
        // The action could not be reached; the server logs its own failures.
        setDeleteError(failure());
      }
    });
  };
  const filtered = repositories.filter((row) => row.name.toLocaleLowerCase(lang).includes(query.trim().toLocaleLowerCase(lang))).sort((left, right) => {
    const comparison = sort.field === "name" ? left.name.localeCompare(right.name, lang) : Date.parse(left.createdAt) - Date.parse(right.createdAt);
    return (sort.descending ? -comparison : comparison) || left.id.localeCompare(right.id);
  });
  const atLimit = repositories.length >= GIT_REPOSITORY_LIMIT;

  const handlers: RepositoryHandlers = {
    connect: setConnecting,
    copyUrl: (repository) => { void copy(repository.url); },
    rename: (repository) => setEditing({ repository }),
    delete: (repository) => { setDeleting(repository); setConfirmation(""); setDeleteError(undefined); },
  };
  const itemProps = (repository: GitRepositorySummary) => ({ repository, lang, disabled: pending || !available, copied: copiedUrl === repository.url, handlers });
  const sortLabel = (field: SortField) => t(field === "name" ? "storage:sortName" : "dashboard:repositories.createdDate");
  const sortHeader = (field: SortField) => {
    const Icon = sort.field !== field ? ArrowUpDown : sort.descending ? ArrowDown : ArrowUp;
    return <Button variant="ghost" size="sm" className="-ml-2 h-8 gap-1 px-2" onClick={() => setSort({ field, descending: sort.field === field ? !sort.descending : field === "createdAt" })}>
      {sortLabel(field)}<Icon className="size-3.5 text-muted-foreground" aria-hidden />
    </Button>;
  };

  return <TooltipProvider><div className="flex flex-col gap-6">
    <div className="flex items-center gap-3">
      <h1 className="text-2xl font-bold">{t("dashboard:repositories.title")}</h1>
      {available && <Badge variant="secondary" className="tabular-nums font-normal">{repositories.length} / {GIT_REPOSITORY_LIMIT}</Badge>}
    </div>
    <div className="flex flex-col gap-4">
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {notice && <p role="status" className="sr-only">{notice}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={create} disabled={pending || !available || atLimit}><Plus className="size-4" aria-hidden />{t("storage:new")}</Button>
        <div className="relative min-w-[12rem] flex-1 sm:max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Label htmlFor="repository-search" className="sr-only">{t("dashboard:repositories.search")}</Label>
          <Input id="repository-search" className="pl-9 pr-9" placeholder={t("dashboard:repositories.search")} value={query} disabled={!available} onChange={(event) => setQuery(event.target.value)} />
          {query && <button className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-1 text-muted-foreground hover:text-foreground" onClick={() => setQuery("")} aria-label={t("storage:clearSearch")}><X className="size-4" aria-hidden /></button>}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <ToggleGroup type="single" variant="outline" size="sm" value={view} onValueChange={changeView} aria-label={t("storage:viewMode")}>
            <ToggleGroupItem value="grid" aria-label={t("storage:viewGrid")}><LayoutGrid className="size-4" aria-hidden /></ToggleGroupItem>
            <ToggleGroupItem value="list" aria-label={t("storage:viewList")}><ListIcon className="size-4" aria-hidden /></ToggleGroupItem>
          </ToggleGroup>
          <Tooltip>
            <TooltipTrigger asChild><Button variant="ghost" size="icon" className="size-9" onClick={refresh} disabled={pending} aria-label={t("dashboard:repositories.refresh")}><RefreshCw className={`size-4 ${pending ? "animate-spin" : ""}`} aria-hidden /></Button></TooltipTrigger>
            <TooltipContent>{t("dashboard:repositories.refresh")}</TooltipContent>
          </Tooltip>
        </div>
      </div>
      {atLimit && available && <p className="text-sm text-muted-foreground">{t("dashboard:repositories.errors.limitReached")}</p>}
      {available && repositories.length > 0 && view === "grid" && <div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="outline" size="sm" className="h-8 gap-1 rounded-full pl-3 pr-2">{t("storage:sortBy")}: {sortLabel(sort.field)}{sort.descending ? <ArrowDown className="size-3.5 opacity-70" aria-hidden /> : <ArrowUp className="size-3.5 opacity-70" aria-hidden />}</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup value={sort.field} onValueChange={(field) => { if (field === "name" || field === "createdAt") setSort({ ...sort, field }); }}>
              <DropdownMenuRadioItem value="name">{sortLabel("name")}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="createdAt">{sortLabel("createdAt")}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value={sort.descending ? "desc" : "asc"} onValueChange={(value) => setSort({ ...sort, descending: value === "desc" })}>
              <DropdownMenuRadioItem value="asc">{t("storage:sortAscending")}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="desc">{t("storage:sortDescending")}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>}
      {available && repositories.length === 0 && <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed px-6 py-16 text-center">
        <GitBranch className="size-10 text-muted-foreground" aria-hidden /><h2 className="font-medium">{t("dashboard:repositories.emptyTitle")}</h2>
      </div>}
      {repositories.length > 0 && filtered.length === 0 && <div className="flex flex-col items-center justify-center gap-2 rounded-lg border px-6 py-16 text-center text-muted-foreground">
        <p className="text-sm">{t("dashboard:repositories.noResults")}</p><Button variant="link" size="sm" onClick={() => setQuery("")}>{t("storage:clearSearch")}</Button>
      </div>}
      {filtered.length > 0 && (view === "grid" ? <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5" aria-label={t("dashboard:repositories.title")}>
        {filtered.map((repository) => <RepositoryGridCard key={repository.id} {...itemProps(repository)} />)}
      </div> : <div className="rounded-md border">
        <Table aria-label={t("dashboard:repositories.title")}>
          <TableHeader><TableRow>
            <TableHead className="h-10 w-full min-w-40 max-w-0" aria-sort={sort.field === "name" ? sort.descending ? "descending" : "ascending" : "none"}>{sortHeader("name")}</TableHead>
            <TableHead className="hidden h-10 w-28 whitespace-nowrap sm:table-cell">{t("dashboard:repositories.visibility")}</TableHead>
            <TableHead className="hidden h-10 w-44 whitespace-nowrap md:table-cell" aria-sort={sort.field === "createdAt" ? sort.descending ? "descending" : "ascending" : "none"}>{sortHeader("createdAt")}</TableHead>
            <TableHead className="h-10 w-12 pl-0"><span className="sr-only">{t("dashboard:repositories.actions")}</span></TableHead>
          </TableRow></TableHeader>
          <TableBody>{filtered.map((repository) => <RepositoryContextMenu key={repository.id} {...itemProps(repository)}>
            <TableRow>
              <TableCell className="w-full min-w-40 max-w-0 py-2">
                <div className="flex min-w-0 items-center gap-2"><GitBranch className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0 flex-1"><h2 className="truncate text-sm font-medium" title={repository.name}><Link prefetch={false} className="block w-full truncate text-left outline-none hover:underline focus-visible:underline aria-disabled:pointer-events-none aria-disabled:opacity-50" aria-disabled={pending || !available} tabIndex={pending || !available ? -1 : undefined} href={repositoryPageHref(lang, repository)}>{repository.name}</Link></h2>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 sm:hidden"><RepositoryVisibility lang={lang} /><RepositoryDate repository={repository} lang={lang} /></div>
                  </div>
                </div>
              </TableCell>
              <TableCell className="hidden w-28 whitespace-nowrap py-2 sm:table-cell"><RepositoryVisibility lang={lang} /></TableCell>
              <TableCell className="hidden w-44 whitespace-nowrap py-2 md:table-cell"><RepositoryDate repository={repository} lang={lang} /></TableCell>
              <TableCell className="w-12 py-2 pl-0"><RepositoryActions {...itemProps(repository)} /></TableCell>
            </TableRow>
          </RepositoryContextMenu>)}</TableBody>
        </Table>
      </div>)}
    </div>
    {editing && <RepositoryNameDialog lang={lang} initialName={editing.repository?.name} onClose={() => setEditing(undefined)} onSubmit={async (name) => {
      const result = editing.repository
        ? await renameRepository(editing.repository.id, name)
        : await createRepository(name, editing.creationId!, userId);
      if (!result.success || !result.data) return result.message ?? failure();
      const repository = result.data;
      setRepositories((rows) => editing.repository ? rows.map((row) => row.id === repository.id ? repository : row) : [repository, ...rows.filter((row) => row.id !== repository.id)]);
      setNotice(t(`dashboard:repositories.${editing.repository ? "renamed" : "created"}`));
      setError(undefined); setEditing(undefined);
    }} />}
    {connecting && <RepositoryTokenDialog repository={connecting} lang={lang} onClose={() => setConnecting(undefined)} />}
    <AlertDialog open={!!deleting} onOpenChange={(open) => { if (!open && !pending) setDeleting(undefined); }}>
      <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("dashboard:repositories.deleteTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("dashboard:repositories.deleteDescription")}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="repository-delete-confirmation" className="break-all">{t("dashboard:repositories.confirmName", { name: deleting?.name, interpolation: { escapeValue: false } })}</Label>
          <Input id="repository-delete-confirmation" autoComplete="off" spellCheck={false} disabled={pending} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
        </div>
        {deleteError && <p role="alert" className="text-sm text-destructive">{deleteError}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" disabled={pending || confirmation !== deleting?.name} onClick={(event) => { event.preventDefault(); remove(); }}>
            {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}{t("dashboard:repositories.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div></TooltipProvider>;
}
