"use client";

import { formatDateTime } from "@beutl/core";
import { useTranslation } from "@beutl/ui/i18n-client";
import { Alert, AlertDescription, AlertTitle } from "@beutl/ui/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@beutl/ui/ui/alert-dialog";
import { Badge } from "@beutl/ui/ui/badge";
import { Button } from "@beutl/ui/ui/button";
import { Card } from "@beutl/ui/ui/card";
import { Skeleton } from "@beutl/ui/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@beutl/ui/ui/toggle-group";
import {
  AudioLines,
  Clapperboard,
  Image as ImageIcon,
  Languages,
  Loader2,
  RefreshCw,
  RotateCcw,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { useCallback, useEffect, useState, useTransition } from "react";
import {
  deleteJobAction,
  listJobsAction,
  refreshVideoJobAction,
  retryJobAction,
} from "./actions";
import {
  AiAccessNotice,
  AiWorkspace,
  blockedReason,
  type AiAccess,
} from "./shared";

type Job = {
  id: string;
  kind: string;
  status: string;
  createdAt: string;
  url: string | null;
  fileName: string | null;
  contentType: string | null;
  inputParams: unknown;
  canRetry?: boolean;
};

const ACTIVE_STATUSES = new Set(["queued", "running", "finalizing"]);
// Long enough that a page left open is not a load generator, short enough that
// a finished video shows up without the user thinking to reload.
const POLL_INTERVAL_MILLISECONDS = 10_000;

const KIND_ICONS: Record<string, typeof ImageIcon> = {
  image: ImageIcon,
  image_edit: WandSparkles,
  stt: AudioLines,
  translation: Languages,
  video: Clapperboard,
};

function isActive(job: Job): boolean {
  return ACTIVE_STATUSES.has(job.status);
}

function promptOf(job: Job): string | null {
  if (job.inputParams === null || typeof job.inputParams !== "object") {
    return null;
  }
  const record = job.inputParams as { prompt?: unknown; filename?: unknown };
  if (typeof record.prompt === "string" && record.prompt.trim()) {
    return record.prompt;
  }
  if (typeof record.filename === "string" && record.filename.trim()) {
    return record.filename;
  }
  return null;
}

function StatusBadge({ lang, status }: { lang: string; status: string }) {
  const { t } = useTranslation(lang);
  const label = t(`dashboard:ai.statuses.${status}`);
  if (status === "failed") {
    return <Badge variant="destructive">{label}</Badge>;
  }
  if (status === "succeeded") {
    return (
      <Badge
        variant="outline"
        className="border-emerald-500/40 text-emerald-700 dark:text-emerald-400"
      >
        {label}
      </Badge>
    );
  }
  return (
    <Badge variant="secondary">
      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
      {label}
    </Badge>
  );
}

export function JobHistory({
  lang,
  access,
}: {
  lang: string;
  access: AiAccess;
}) {
  const { t } = useTranslation(lang);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [jobsMessage, setJobsMessage] = useState<string | null>(null);
  const [isSyncing, startSync] = useTransition();
  const [isDeleting, startDelete] = useTransition();
  const [isRetrying, startRetry] = useTransition();
  const [isLoadingMore, startLoadMore] = useTransition();
  const [nextCursor, setNextCursor] = useState<{
    createdAt: string;
    id: string;
  } | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showingMorePages, setShowingMorePages] = useState(false);
  const [brokenThumbnails, setBrokenThumbnails] = useState<Set<string>>(
    () => new Set(),
  );
  const [confirmAction, setConfirmAction] = useState<{
    type: "delete" | "retry";
    jobId: string;
  } | null>(null);

  const loadJobs = useCallback(async () => {
    const result = await listJobsAction();
    if (result.success) {
      setJobs((result.jobs ?? []) as Job[]);
      setNextCursor(result.nextCursor ?? null);
      setShowingMorePages(false);
      setJobsMessage(null);
    } else {
      setJobsMessage(result.message ?? null);
    }
  }, []);

  // Reaching this screen is itself the request to see the history; making the
  // user press a button first left it looking empty.
  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  const activeCount = jobs?.filter(isActive).length ?? 0;
  // Refreshing replaces the list with the first page, so polling has to stop
  // once further pages are open or it would collapse them under the user.
  const shouldPoll = activeCount > 0 && !showingMorePages;

  useEffect(() => {
    if (!shouldPoll) return;
    const timer = window.setInterval(() => {
      // A background tab does not need fresh job rows, and the interval keeps
      // firing there.
      if (document.visibilityState !== "visible") return;
      void loadJobs();
    }, POLL_INTERVAL_MILLISECONDS);
    return () => window.clearInterval(timer);
  }, [shouldPoll, loadJobs]);

  function loadMore() {
    if (!nextCursor) return;
    startLoadMore(async () => {
      const result = await listJobsAction(nextCursor);
      if (result.success) {
        setJobs((current) => [...(current ?? []), ...((result.jobs ?? []) as Job[])]);
        setNextCursor(result.nextCursor ?? null);
        setShowingMorePages(true);
        setJobsMessage(null);
      } else {
        setJobsMessage(result.message ?? null);
      }
    });
  }

  function syncJob(jobId: string) {
    startSync(async () => {
      await refreshVideoJobAction(jobId);
      await loadJobs();
    });
  }

  function confirmDelete(jobId: string) {
    startDelete(async () => {
      const result = await deleteJobAction(jobId);
      if (result.success) {
        setJobs((current) =>
          current === null ? current : current.filter((job) => job.id !== jobId),
        );
        setJobsMessage(null);
      } else {
        setJobsMessage(result.message ?? null);
      }
    });
  }

  function confirmRetry(jobId: string) {
    startRetry(async () => {
      const result = await retryJobAction(jobId);
      if (result.success) {
        setJobsMessage(null);
        await loadJobs();
      } else {
        setJobsMessage(result.message ?? null);
      }
    });
  }

  const blocked = blockedReason(access, []);
  const visibleJobs =
    jobs === null
      ? null
      : statusFilter === "all"
        ? jobs
        : statusFilter === "active"
          ? jobs.filter(isActive)
          : jobs.filter((job) => job.status === statusFilter);

  const history = (
    <>
      <AlertDialog
        open={confirmAction !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction?.type === "delete"
                ? t("dashboard:ai.deleteJobTitle")
                : t("dashboard:ai.retryJobTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction?.type === "delete"
                ? t("dashboard:ai.deleteJobConfirmation")
                : t("dashboard:ai.retryJobConfirmation")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmAction?.type === "delete") {
                  confirmDelete(confirmAction.jobId);
                } else if (confirmAction?.type === "retry") {
                  confirmRetry(confirmAction.jobId);
                }
                setConfirmAction(null);
              }}
            >
              {confirmAction?.type === "delete"
                ? t("dashboard:ai.delete")
                : t("dashboard:ai.retry")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={statusFilter}
            onValueChange={(next) => next && setStatusFilter(next)}
            className="flex-wrap justify-start"
          >
            <ToggleGroupItem value="all">
              {t("dashboard:ai.filterAll")}
            </ToggleGroupItem>
            <ToggleGroupItem value="active">
              {t("dashboard:ai.filterActive")}
              {activeCount > 0 && (
                <span className="ml-1 tabular-nums">({activeCount})</span>
              )}
            </ToggleGroupItem>
            <ToggleGroupItem value="succeeded">
              {t("dashboard:ai.statuses.succeeded")}
            </ToggleGroupItem>
            <ToggleGroupItem value="failed">
              {t("dashboard:ai.statuses.failed")}
            </ToggleGroupItem>
          </ToggleGroup>
          <Button type="button" variant="outline" size="sm" onClick={loadJobs}>
            <RefreshCw className="mr-2 h-4 w-4" />
            {t("dashboard:ai.refresh")}
          </Button>
        </div>

        {activeCount > 0 && (
          <p className="border-t px-4 py-2 text-xs text-muted-foreground">
            {t("dashboard:ai.autoRefreshNotice")}
          </p>
        )}

        {jobsMessage && (
          <div className="border-t p-4">
            <Alert variant="destructive">
              <AlertTitle>{t("error")}</AlertTitle>
              <AlertDescription>{jobsMessage}</AlertDescription>
            </Alert>
          </div>
        )}

        {visibleJobs === null ? (
          <div className="flex flex-col gap-3 border-t p-6">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-12 w-full" />
            ))}
          </div>
        ) : visibleJobs.length === 0 ? (
          <div className="border-t p-6">
            <p className="text-sm text-muted-foreground">
              {jobs?.length === 0
                ? t("dashboard:ai.noJobs")
                : t("dashboard:ai.noJobsForFilter")}
            </p>
          </div>
        ) : (
          <>
            <ul className="border-t [&_li:last-child]:border-0">
              {visibleJobs.map((job) => {
                const KindIcon = KIND_ICONS[job.kind] ?? ImageIcon;
                const prompt = promptOf(job);
                const isImage = job.contentType?.startsWith("image/") ?? false;
                return (
                  <li
                    key={job.id}
                    className="flex flex-wrap items-center gap-3 border-b px-4 py-3"
                  >
                    {job.url && isImage && !brokenThumbnails.has(job.id) ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={job.url}
                        alt=""
                        className="h-12 w-12 shrink-0 rounded border object-cover"
                        // A result the storage layer no longer has would leave
                        // a broken image where the row's only visual is.
                        onError={() =>
                          setBrokenThumbnails((current) =>
                            new Set(current).add(job.id),
                          )
                        }
                      />
                    ) : (
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded border bg-muted">
                        <KindIcon className="h-5 w-5 text-muted-foreground" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-bold">
                          {t(`dashboard:ai.kinds.${job.kind}`)}
                        </p>
                        <StatusBadge lang={lang} status={job.status} />
                      </div>
                      {prompt && (
                        <p className="truncate text-sm text-muted-foreground">
                          {prompt}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {formatDateTime(job.createdAt, lang)}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      {job.url && (
                        <Button asChild variant="outline" size="sm">
                          <a href={job.url} target="_blank" rel="noreferrer">
                            {t("dashboard:ai.viewResult")}
                          </a>
                        </Button>
                      )}
                      {job.kind === "video" && isActive(job) && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={isSyncing}
                          onClick={() => syncJob(job.id)}
                        >
                          {t("dashboard:ai.sync")}
                        </Button>
                      )}
                      {job.canRetry && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          aria-label={t("dashboard:ai.retry")}
                          title={t("dashboard:ai.retry")}
                          disabled={isRetrying}
                          onClick={() =>
                            setConfirmAction({ type: "retry", jobId: job.id })
                          }
                        >
                          <RotateCcw className="h-4 w-4" />
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0 text-muted-foreground"
                        aria-label={t("dashboard:ai.delete")}
                        title={t("dashboard:ai.delete")}
                        disabled={isDeleting}
                        onClick={() =>
                          setConfirmAction({ type: "delete", jobId: job.id })
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
            {nextCursor && (
              <div className="flex justify-center p-4">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isLoadingMore}
                  onClick={loadMore}
                >
                  {t("dashboard:ai.loadMore")}
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );

  return (
    <div className="flex flex-col gap-4">
      {blocked && <AiAccessNotice lang={lang} reason={blocked} />}
      {/* No input-and-result pair here, so the one-column shell keeps the rows
          from stretching the full 1152px and leaving a gap between a job's
          prompt and its buttons. */}
      <AiWorkspace form={history} />
    </div>
  );
}
