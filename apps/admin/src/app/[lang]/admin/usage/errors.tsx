import Link from "next/link";
import { getTranslation } from "@beutl/i18n";
import { formatNumber } from "../../../../lib/format";
import type { DesktopUsageRange } from "../../../../lib/desktop-usage";
import {
  DESKTOP_ERROR_LEVELS,
  DESKTOP_ERROR_LIMIT,
  type DesktopError,
  type DesktopErrorFilter,
} from "../../../../lib/desktop-errors";
import type { DesktopErrorResult } from "../../../../lib/desktop-errors-server";
import { DesktopUsageHeader } from "./header";

export async function DesktopErrorsView({
  lang,
  range,
  level,
  result,
}: {
  lang: string;
  range: DesktopUsageRange;
  level: DesktopErrorFilter;
  result: DesktopErrorResult;
}) {
  const { t } = await getTranslation(lang);
  const header = await DesktopUsageHeader({ lang, range, tab: "errors", level });
  const base = `/${lang}/admin/usage?tab=errors&range=${range}`;
  const filters = (
    <nav aria-label={t("admin:desktopErrors.level")} className="flex flex-wrap gap-2">
      {(["all", ...DESKTOP_ERROR_LEVELS] as const).map((value) => (
        <Link
          key={value}
          href={`${base}&level=${value}`}
          prefetch={false}
          aria-current={value === level ? "page" : undefined}
          className={`rounded-md border px-3 py-2 text-sm ${value === level ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted"}`}
        >
          {t(`admin:desktopErrors.levels.${value}`)}
        </Link>
      ))}
    </nav>
  );
  if (result.status !== "ready")
    return (
      <div className="flex min-w-0 flex-col gap-6">
        {header}
        {filters}
        <p role="status" className="rounded-lg border bg-card p-6">
          {t(`admin:desktopErrors.${result.status}`)}
        </p>
      </div>
    );

  const { report } = result;
  const formatter = new Intl.DateTimeFormat(lang, {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const timestamp = (value: Date | number) => `${formatter.format(value)} JST`;
  const number = (value: number) => formatNumber(value, lang);
  const levelBadge = (entry: DesktopError) => (
    <span
      className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${entry.level === "error" ? "bg-amber-500/10 text-amber-700 dark:text-amber-400" : "bg-destructive/10 text-destructive"}`}
    >
      {t(`admin:desktopErrors.levels.${entry.level}`)}
    </span>
  );
  const diagnosticText = (label: string, text: string) => (
    <div className="min-w-0">
      <h4 className="mb-2 text-xs font-medium text-muted-foreground">{label}</h4>
      <pre className="max-h-80 overflow-y-auto rounded-md bg-muted/50 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
        {text}
      </pre>
    </div>
  );

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {header}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {filters}
        <p className="text-xs text-muted-foreground">
          {timestamp(report.since)} — {timestamp(report.until)}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {(["all", ...DESKTOP_ERROR_LEVELS] as const).map((value) => (
          <div key={value} className="rounded-lg border bg-card p-5">
            <div className="text-2xl font-semibold tabular-nums">
              {number(value === "all" ? report.total : report.levels[value])}
            </div>
            <div className="mt-1 text-sm text-muted-foreground">
              {t(
                value === "all"
                  ? "admin:desktopErrors.total"
                  : `admin:desktopErrors.levels.${value}`,
              )}
            </div>
          </div>
        ))}
      </div>
      {(report.oldest || report.truncated) && (
        <div className="space-y-2 text-sm text-muted-foreground">
          {report.oldest && report.newest && (
            <p className="text-xs">
              {t("admin:desktopErrors.coverage", {
                oldest: timestamp(report.oldest),
                newest: timestamp(report.newest),
                interpolation: { escapeValue: false },
              })}
            </p>
          )}
          {report.truncated && (
            <p
              role="status"
              className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-foreground"
            >
              {t("admin:desktopErrors.truncated", { count: DESKTOP_ERROR_LIMIT })}
            </p>
          )}
        </div>
      )}
      <section className="min-w-0">
        <h2 className="mb-4 text-lg font-semibold">
          {t("admin:desktopErrors.groups", { count: report.groups.length })}
        </h2>
        {report.total === 0 ? (
          <p role="status" className="rounded-lg border bg-card p-6">
            {t("admin:desktopErrors.empty")}
          </p>
        ) : (
          <div className="space-y-3">
            {report.groups.map((group) => {
              const latest = group.entries[0];
              const heading =
                latest.exceptionType ||
                (latest.template.includes("{Message}") && latest.message.split(/\r?\n/, 1)[0]) ||
                latest.template;
              return (
                <details key={group.key} className="group min-w-0 rounded-lg border bg-card">
                  <summary className="cursor-pointer rounded-lg p-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:p-5">
                    <span className="ml-1 font-semibold break-all">{heading}</span>
                    <span className="ml-3 inline-flex rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium tabular-nums">
                      {t("admin:desktopErrors.occurrences", { count: group.entries.length })}
                    </span>
                    <span className="mt-2 block text-xs break-all text-muted-foreground">
                      {latest.scope || t("admin:desktopErrors.unknownScope")}
                    </span>
                    {heading !== latest.template && (
                      <span className="mt-1 block text-sm break-all text-muted-foreground">
                        {latest.template}
                      </span>
                    )}
                    <span className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {levelBadge(latest)}
                      <span>
                        {t("admin:desktopErrors.latest", {
                          time: timestamp(latest.timestampMs),
                          interpolation: { escapeValue: false },
                        })}
                      </span>
                    </span>
                  </summary>
                  <div className="space-y-3 border-t p-4 sm:p-5">
                    <h3 className="text-sm font-medium">{t("admin:desktopErrors.records")}</h3>
                    {group.entries.map((entry, index) => (
                      <details
                        key={`${entry.timestampNs}-${index}`}
                        open={index === 0}
                        className="min-w-0 rounded-md border"
                      >
                        <summary className="cursor-pointer rounded-md p-3 text-sm focus-visible:outline-2 focus-visible:outline-primary">
                          <time
                            dateTime={new Date(entry.timestampMs).toISOString()}
                            className="mr-3 tabular-nums"
                          >
                            {timestamp(entry.timestampMs)}
                          </time>
                          {levelBadge(entry)}
                        </summary>
                        <div className="min-w-0 space-y-4 border-t p-3 sm:p-4">
                          <dl className="grid gap-3 text-sm sm:grid-cols-2">
                            {[
                              ["os", entry.os],
                              ["version", entry.version],
                              ["scope", entry.scope],
                              ["exceptionType", entry.exceptionType],
                            ].map(([key, value]) => (
                              <div key={key} className="min-w-0">
                                <dt className="text-xs text-muted-foreground">
                                  {t(`admin:desktopErrors.${key}`)}
                                </dt>
                                <dd className="mt-1 break-all">{value || "—"}</dd>
                              </div>
                            ))}
                          </dl>
                          {entry.message &&
                            entry.message !== entry.stackTrace &&
                            diagnosticText(t("admin:desktopErrors.message"), entry.message)}
                          {Object.keys(entry.context).length > 0 && (
                            <dl className="grid gap-2 rounded-md bg-muted/30 p-3 text-xs sm:grid-cols-2">
                              {Object.entries(entry.context).map(([key, value]) => (
                                <div key={key} className="min-w-0">
                                  <dt className="font-medium">{key}</dt>
                                  <dd className="mt-1 break-all">{value}</dd>
                                </div>
                              ))}
                            </dl>
                          )}
                          {entry.stackTrace ? (
                            diagnosticText(t("admin:desktopErrors.stackTrace"), entry.stackTrace)
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              {t("admin:desktopErrors.noStackTrace")}
                            </p>
                          )}
                        </div>
                      </details>
                    ))}
                  </div>
                </details>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
