"use client";

import { formatDateTime, randomUuid } from "@beutl/core";
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
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  deleteJobAction,
  listJobsAction,
  refreshVideoJobAction,
  retryJobAction,
} from "./actions";
import {
  readCues,
  readTranslatedCues,
  toPlainText,
  toSrt,
  toVtt,
} from "@/lib/subtitle-format";
import {
  AiAccessNotice,
  AiWorkspace,
  blockedReason,
  downloadFromUrl,
  downloadTextFile,
  type AiAccess,
} from "./shared";
import {
  getOrCreateStoredRetryAttempt,
  removeStoredRetryAttempt,
  retryJobFingerprint,
  updateStoredRetryAttempt,
  type StoredAiRetryAttempt,
} from "@/lib/ai-retry-attempt";

type Job = {
  id: string;
  kind: string;
  status: string;
  createdAt: string;
  url: string | null;
  fileName: string | null;
  contentType: string | null;
  inputParams: unknown;
  model?: string | null;
  canRetry?: boolean;
};

type RetryAttempt = StoredAiRetryAttempt;

// Kinds whose result is a stored JSON document rather than a media file.
const SUBTITLE_KINDS = new Set(["stt", "translation"]);

function isSubtitleKind(kind: string): boolean {
  return SUBTITLE_KINDS.has(kind);
}

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
  userId,
}: {
  lang: string;
  access: AiAccess;
  userId: string;
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
  const [exportingJobId, setExportingJobId] = useState<string | null>(null);
  const [retryAttempt, setRetryAttempt] = useState<RetryAttempt | null>(null);
  const [retryStorageReady, setRetryStorageReady] = useState(false);
  const retryPersistedRef = useRef<RetryAttempt | null>(null);

  useEffect(() => setRetryStorageReady(true), []);

  useEffect(() => {
    if (!retryStorageReady || typeof window === "undefined") return;
    const previous = retryPersistedRef.current;
    retryPersistedRef.current = retryAttempt;
    const locks = (navigator as Navigator & {
      locks?: Parameters<typeof updateStoredRetryAttempt>[0]["locks"];
    }).locks;
    if (retryAttempt === null) {
      if (previous) {
        void removeStoredRetryAttempt({
          storage: window.localStorage,
          locks,
          userId,
          jobId: previous.jobId,
          expectedKey: previous.idempotencyKey,
          expectedFingerprint: previous.expectedFingerprint,
        });
      }
      return;
    }
    // Every mutation is an exact-key CAS under the per-job lock. A stale K1
    // effect therefore cannot overwrite or delete a newer K2 generation.
    void updateStoredRetryAttempt({
      storage: window.localStorage,
      locks,
      userId,
      attempt: retryAttempt,
      expectedKey: previous?.idempotencyKey,
    });
  }, [retryAttempt, retryStorageReady, userId]);

  useEffect(() => {
    if (!retryAttempt || jobs === null) return;
    const job = jobs.find((candidate) => candidate.id === retryAttempt.jobId);
    if (job) {
      void retryJobFingerprint({
        kind: job.kind,
        model: job.model ?? null,
        inputParams: job.inputParams,
      }).then((currentFingerprint) => {
        if (retryAttempt.expectedFingerprint !== currentFingerprint &&
            !retryAttempt.expectedPayload) {
          // Discovery proved that this key no longer belongs to the same job/body
          // (or the job was deleted). Do not let a stale confirmation rerun it.
          setRetryAttempt(null);
          setJobsMessage(t("api-errors:aiRequestChanged"));
        }
      });
    }
  }, [jobs, retryAttempt, t]);
  // A retry reserves and charges again, so it carries the key that makes one
  // confirmation land on one job however many times it reaches the server. The
  // key belongs to the confirmation, not to the click.
  const [confirmAction, setConfirmAction] = useState<
    | { type: "delete"; jobId: string }
    | { type: "retry"; jobId: string; idempotencyKey: string }
    | null
  >(null);

  const loadJobs = useCallback(async () => {
    // This runs unattended — on mount and from the poll — so a rejection has
    // nowhere to surface. Left unhandled it stops the list at its skeletons and
    // gives the user nothing to act on.
    try {
      const result = await listJobsAction();
      if (result.success) {
        setJobs((result.jobs ?? []) as Job[]);
        setNextCursor(result.nextCursor ?? null);
        setShowingMorePages(false);
        setJobsMessage(null);
      } else {
        setJobsMessage(result.message ?? null);
      }
    } catch (error) {
      console.error("Failed to load the AI job history", error);
      setJobs((current) => current ?? []);
      setJobsMessage(t("dashboard:ai.jobsLoadFailed"));
    }
  }, [t]);

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

  // Recovering a paid result from the history: the stored JSON is fetched and
  // converted here rather than handed to the browser as-is. A translation only
  // becomes a cue file when its segments kept the timings they were sent with.
  async function exportSubtitle(job: Job, format: "srt" | "vtt" | "txt") {
    if (!job.url) return;
    setExportingJobId(job.id);
    try {
      const response = await fetch(job.url);
      if (!response.ok) throw new Error(`Result fetch failed: ${response.status}`);
      const stored = (await response.json()) as { segments?: unknown };
      // Plain text is the words alone, so it is recoverable from a translation
      // that was run on an untimed source. Only a cue file needs the timings,
      // and only a translation can be missing them.
      const cues =
        job.kind === "translation" && format !== "txt"
          ? readTranslatedCues(stored.segments)
          : readCues(stored.segments);
      if (!cues || cues.length === 0) {
        setJobsMessage(t("dashboard:ai.resultExportUnavailable"));
        return;
      }
      const base = `${job.kind}-${job.id}`;
      if (format === "srt") {
        downloadTextFile(
          toSrt(cues),
          `${base}.srt`,
          "application/x-subrip;charset=utf-8",
        );
      } else if (format === "vtt") {
        downloadTextFile(toVtt(cues), `${base}.vtt`, "text/vtt;charset=utf-8");
      } else {
        downloadTextFile(toPlainText(cues), `${base}.txt`);
      }
      setJobsMessage(null);
    } catch (error) {
      console.error("Failed to export an AI result", error);
      setJobsMessage(t("dashboard:ai.resultExportFailed"));
    } finally {
      setExportingJobId(null);
    }
  }

  function syncJob(jobId: string) {
    startSync(async () => {
      const result = await refreshVideoJobAction(jobId);
      await loadJobs();
      // After the reload, not before: loadJobs clears the banner when it
      // succeeds, and both updates land in one transition, so a message set
      // first is erased before it is ever painted — leaving a provider that
      // keeps failing looking like a button that does nothing.
      setJobsMessage(result.success ? null : (result.message ?? null));
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

  function confirmRetry(attempt: RetryAttempt) {
    setRetryAttempt((current) =>
      current?.jobId === attempt.jobId
        ? { ...current, state: "submitting" }
        : attempt,
    );
    startRetry(async () => {
      try {
        const result = await retryJobAction(
          attempt.jobId,
          attempt.idempotencyKey,
          attempt.expectedFingerprint || attempt.expectedPayload,
        );
        if (result.success || !result.keepIdempotencyKey) {
          setRetryAttempt(null);
        } else {
          setRetryAttempt((current) =>
            current?.jobId === attempt.jobId
              ? { ...current, state: "ambiguous" }
              : current,
          );
        }
        setJobsMessage(result.success ? null : (result.message ?? null));
        if (result.success) await loadJobs();
      } catch (error) {
        console.error("AI retry response was lost", error);
        setRetryAttempt((current) =>
          current?.jobId === attempt.jobId
            ? { ...current, state: "ambiguous" }
            : current,
        );
        setJobsMessage(t("dashboard:ai.jobsLoadFailed"));
      }
    });
  }

  async function beginRetry(job: Job) {
    const expectedFingerprint = await retryJobFingerprint({
      kind: job.kind,
      model: job.model ?? null,
      inputParams: job.inputParams,
    });
    const current = retryAttempt?.jobId === job.id ? retryAttempt : null;
    const attempt = current ?? await getOrCreateStoredRetryAttempt({
      storage: window.localStorage,
      locks: navigator.locks,
      userId,
      jobId: job.id,
      expectedFingerprint,
      createKey: randomUuid,
    });
    if (!attempt) {
      setJobsMessage(t("dashboard:ai.jobsLoadFailed"));
      return;
    }
    setRetryAttempt(attempt);
    setConfirmAction({
      type: "retry",
      jobId: attempt.jobId,
      idempotencyKey: attempt.idempotencyKey,
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
              disabled={isRetrying}
              onClick={() => {
                if (confirmAction?.type === "delete") {
                  confirmDelete(confirmAction.jobId);
                } else if (confirmAction?.type === "retry") {
                  const attempt = retryAttempt;
                  if (attempt?.jobId === confirmAction.jobId) {
                    confirmRetry(attempt);
                  }
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
                      {job.url && isSubtitleKind(job.kind) ? (
                        // A finished transcript or translation is stored as
                        // JSON, so "view" opened a raw object in a tab. What the
                        // user paid for is a subtitle file.
                        <>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={exportingJobId === job.id}
                            onClick={() => exportSubtitle(job, "srt")}
                          >
                            SRT
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={exportingJobId === job.id}
                            onClick={() => exportSubtitle(job, "vtt")}
                          >
                            VTT
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={exportingJobId === job.id}
                            onClick={() => exportSubtitle(job, "txt")}
                          >
                            {t("dashboard:ai.copyText")}
                          </Button>
                        </>
                      ) : (
                        job.url && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              downloadFromUrl(
                                job.url as string,
                                job.fileName ?? `ai-result-${job.id}`,
                              )
                            }
                          >
                            {t("dashboard:ai.download")}
                          </Button>
                        )
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
                          onClick={() => void beginRetry(job)}
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
