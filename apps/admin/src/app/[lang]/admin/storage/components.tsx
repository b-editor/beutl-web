"use client";

import type { MoveBatchOutcome, StorageProvider } from "@beutl/api";
import { useTranslation } from "@beutl/ui/i18n-client";
import { Button } from "@beutl/ui/ui/button";
import { Checkbox } from "@beutl/ui/ui/checkbox";
import { Input } from "@beutl/ui/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@beutl/ui/ui/select";
import { Search } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { moveFileToProvider, moveFilesBatch } from "./actions";

function localizedActionMessage(
  message: string | undefined,
  fallback: string,
  unauthenticated: string,
  forbidden: string,
): string {
  if (message === "Unauthenticated") return unauthenticated;
  if (message === "Forbidden") return forbidden;
  return message ?? fallback;
}

export function StorageSearchForm({
  lang,
  query,
  order,
}: {
  lang: string;
  query?: string;
  order: "asc" | "desc";
}) {
  const { t } = useTranslation(lang);
  const router = useRouter();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(query || "");

  // 戻る/進むで URL が変わったときに入力欄が古いまま残らないようにする。
  useEffect(() => {
    setValue(query || "");
  }, [query]);

  const navigate = (next: { q?: string; order?: "asc" | "desc" }) => {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    const q = next.q ?? value;
    if (q) params.set("q", q);
    else params.delete("q");
    params.set("order", next.order ?? order);
    params.delete("page");
    router.push(`/${lang}/admin/storage?${params.toString()}`);
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        navigate({});
      }}
      className="flex flex-wrap gap-2"
    >
      <Input
        type="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={t("admin:storage.search.placeholder")}
        aria-label={t("admin:storage.search.placeholder")}
        className="max-w-sm"
      />
      <Button type="submit" variant="outline">
        <Search className="mr-2 h-4 w-4" />
        {t("admin:storage.search.submit")}
      </Button>
      <Select value={order} onValueChange={(next) => navigate({ order: next === "desc" ? "desc" : "asc" })}>
        <SelectTrigger className="w-40" aria-label={t("admin:storage.search.order")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="asc">{t("admin:storage.search.oldestFirst")}</SelectItem>
          <SelectItem value="desc">{t("admin:storage.search.newestFirst")}</SelectItem>
        </SelectContent>
      </Select>
    </form>
  );
}

export function MoveFileButton({
  lang,
  fileId,
  to,
}: {
  lang: string;
  fileId: string;
  to: StorageProvider;
}) {
  const { t } = useTranslation(lang);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const run = () =>
    startTransition(async () => {
      setMessage(null);
      const result = await moveFileToProvider(lang, { fileId, to });
      setMessage(
        localizedActionMessage(
          result.message,
          t("admin:storage.messages.failed"),
          t("admin:storage.messages.unauthenticated"),
          t("admin:storage.messages.forbidden"),
        ),
      );
      if (result.success) router.refresh();
    });

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" variant="outline" disabled={pending} onClick={run}>
        {pending
          ? t("admin:storage.moving")
          : t("admin:storage.moveTo", { provider: t(`admin:storage.providers.${to}`) })}
      </Button>
      {message && <p className="max-w-xs text-right text-xs text-muted-foreground">{message}</p>}
    </div>
  );
}

type BatchTotals = Pick<MoveBatchOutcome, "scanned" | "moved" | "alreadyThere" | "missing" | "failed">;

const emptyTotals = (): BatchTotals => ({
  scanned: 0,
  moved: 0,
  alreadyThere: 0,
  missing: 0,
  failed: [],
});

export function StorageBatchPanel({
  lang,
  destinations,
  defaultTo,
}: {
  lang: string;
  destinations: { provider: StorageProvider; label: string }[];
  defaultTo: StorageProvider;
}) {
  const { t } = useTranslation(lang);
  const router = useRouter();
  const [to, setTo] = useState<StorageProvider>(defaultTo);
  const [keepRunning, setKeepRunning] = useState(true);
  const [pending, startTransition] = useTransition();
  const [totals, setTotals] = useState<BatchTotals>(emptyTotals);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [state, setState] = useState<"idle" | "done" | "paused">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const stopRequested = useRef(false);

  const reset = () => {
    setTotals(emptyTotals());
    setCursor(undefined);
    setState("idle");
    setMessage(null);
  };

  const run = () =>
    startTransition(async () => {
      stopRequested.current = false;
      setMessage(null);
      let position = cursor;
      for (;;) {
        const result = await moveFilesBatch(lang, { to, cursor: position });
        if (!result.success || !result.data) {
          setMessage(
            localizedActionMessage(
              result.message,
              t("admin:storage.messages.failed"),
              t("admin:storage.messages.unauthenticated"),
              t("admin:storage.messages.forbidden"),
            ),
          );
          setState("paused");
          break;
        }
        const batch = result.data;
        setTotals((previous) => ({
          scanned: previous.scanned + batch.scanned,
          moved: previous.moved + batch.moved,
          alreadyThere: previous.alreadyThere + batch.alreadyThere,
          missing: previous.missing + batch.missing,
          failed: [...previous.failed, ...batch.failed],
        }));
        position = batch.nextCursor;
        setCursor(position);
        if (batch.done) {
          setState("done");
          break;
        }
        if (!keepRunning || stopRequested.current) {
          setState("paused");
          break;
        }
      }
      router.refresh();
    });

  return (
    <section className="flex flex-col gap-3 rounded-lg border p-4">
      <div>
        <h2 className="font-semibold">{t("admin:storage.batch.heading")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin:storage.batch.description")}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          {t("admin:storage.batch.destination")}
          <Select
            value={to}
            onValueChange={(next) => {
              setTo(next as StorageProvider);
              reset();
            }}
            disabled={pending}
          >
            <SelectTrigger className="w-64" aria-label={t("admin:storage.batch.destination")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {destinations.map((destination) => (
                <SelectItem key={destination.provider} value={destination.provider}>
                  {destination.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={keepRunning}
            onCheckedChange={(checked) => setKeepRunning(checked === true)}
            disabled={pending}
          />
          {t("admin:storage.batch.keepRunning")}
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={run} disabled={pending || state === "done"}>
          {pending ? t("admin:storage.batch.running") : t("admin:storage.batch.run")}
        </Button>
        {pending && keepRunning && (
          <Button
            variant="outline"
            onClick={() => {
              stopRequested.current = true;
            }}
          >
            {t("admin:storage.batch.stop")}
          </Button>
        )}
        {!pending && (cursor !== undefined || state !== "idle") && (
          <Button variant="ghost" onClick={reset}>
            {t("admin:storage.batch.reset")}
          </Button>
        )}
      </div>
      {(totals.scanned > 0 || state !== "idle") && (
        <p className="text-sm">
          {t("admin:storage.batch.progress", {
            scanned: totals.scanned,
            moved: totals.moved,
            alreadyThere: totals.alreadyThere,
            missing: totals.missing,
            failed: totals.failed.length,
          })}
        </p>
      )}
      {state === "done" && (
        <p className="text-sm text-muted-foreground">{t("admin:storage.batch.done")}</p>
      )}
      {state === "paused" && !message && (
        <p className="text-sm text-muted-foreground">{t("admin:storage.batch.paused")}</p>
      )}
      {message && <p className="text-sm text-destructive">{message}</p>}
      {totals.failed.length > 0 && (
        <div className="text-sm">
          <p className="font-medium">{t("admin:storage.batch.failures")}</p>
          <ul className="mt-1 list-disc pl-5 text-muted-foreground">
            {totals.failed.map((failure) => (
              <li key={`${failure.id}:${failure.error}`}>
                <span className="text-foreground">{failure.name}</span>: {failure.error}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
