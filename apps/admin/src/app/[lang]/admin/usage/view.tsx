import React from "react";
import Link from "next/link";
import { getTranslation } from "@beutl/i18n";
import { formatNumber, formatTimestamp } from "../../../../lib/format";
import {
  DESKTOP_USAGE_RANGES,
  rankUsage,
  type DesktopUsageRange,
} from "../../../../lib/desktop-usage";
import type { UsageReportResult } from "../../../../lib/desktop-usage-server";
import { UsageActivityChart } from "./chart";

export async function DesktopUsageView({
  lang,
  range,
  requestedTool,
  result,
}: {
  lang: string;
  range: DesktopUsageRange;
  requestedTool?: string;
  result: UsageReportResult;
}) {
  const { t } = await getTranslation(lang);
  const toolName = (id: string) =>
    t(`admin:desktopUsage.toolNames.${id}`, { defaultValue: id });
  const title = t("admin:desktopUsage.title");
  const base = `/${lang}/admin/usage`;

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold">{title}</h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          {t("admin:desktopUsage.description")}
        </p>
      </div>
      <nav
        aria-label={t("admin:desktopUsage.rangeLabel")}
        className="flex gap-1 rounded-lg border p-1"
      >
        {DESKTOP_USAGE_RANGES.map((value) => (
          <Link
            key={value}
            href={`${base}?range=${value}`}
            prefetch={false}
            aria-current={value === range ? "page" : undefined}
            className={`rounded-md px-3 py-2 text-sm ${value === range ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
          >
            {t(`admin:desktopUsage.range.${value}`)}
          </Link>
        ))}
      </nav>
    </div>
  );

  if (result.status !== "ready")
    return (
      <div className="flex flex-col gap-6">
        {header}
        <p role="status" className="rounded-lg border bg-card p-6">
          {t(`admin:desktopUsage.${result.status}`)}
        </p>
      </div>
    );

  const { report } = result;
  const total = (event: string) =>
    report.rows
      .filter((row) => row.event === event)
      .reduce((sum, row) => sum + row.count, 0);
  const started = report.rows.filter((row) => row.event === "session.started");
  const operations = report.rows.filter((row) => row.event === "operation");
  const tools = [
    ...new Set(
      report.rows
        .filter(
          (row) =>
            row.event.startsWith("tool.") || row.event.startsWith("editor."),
        )
        .map((row) => row.tool),
    ),
  ].sort();
  const tool =
    requestedTool && tools.includes(requestedTool) ? requestedTool : "";
  const features = rankUsage(
    report.rows.filter(
      (row) =>
        [
          "tool.command",
          "tool.action",
          "tool.setting",
          "editor.edit",
          "editor.property",
          "editor.history",
        ].includes(row.event) &&
        (!tool || row.tool === tool),
    ),
    (row) => JSON.stringify([row.tool, row.feature, row.event]),
  );
  const exports = operations.filter((row) => row.feature === "export");
  const exportCount = exports.reduce((sum, row) => sum + row.count, 0);
  const exportSuccess = exports
    .filter((row) => row.outcome === "succeeded")
    .reduce((sum, row) => sum + row.count, 0);
  const runningHours =
    report.rows
      .filter((row) => row.event === "session.heartbeat")
      .reduce((sum, row) => sum + row.durationMs, 0) / 3_600_000;
  const number = (value: number) =>
    formatNumber(Math.round(value * 10) / 10, lang);
  const stats = [
    [t("admin:desktopUsage.sessions"), number(total("session.started"))],
    [t("admin:desktopUsage.runningHours"), number(runningHours)],
    [t("admin:desktopUsage.edits"), number(total("editor.edit"))],
    [
      t("admin:desktopUsage.exportSuccess"),
      exportCount
        ? `${number((100 * exportSuccess) / exportCount)}% (${number(exportSuccess)}/${number(exportCount)})`
        : "—",
    ],
  ];
  const ranking = (
    heading: string,
    entries: { label: string; count: number }[],
    linkTools = false,
  ) => (
    <section className="rounded-lg border bg-card p-5">
      <h2 className="mb-4 text-lg font-semibold">{heading}</h2>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("admin:desktopUsage.empty")}
        </p>
      ) : (
        <ol className="flex flex-col gap-3">
          {entries.slice(0, 30).map((entry) => (
            <li key={entry.label}>
              <div className="mb-1 flex items-baseline justify-between gap-4 text-sm">
                {linkTools ? (
                  <Link
                    className="underline underline-offset-4"
                    href={`${base}?range=${range}&tool=${encodeURIComponent(entry.label)}`}
                    prefetch={false}
                  >
                    {toolName(entry.label)}
                  </Link>
                ) : (
                  <span className="break-all">{entry.label}</span>
                )}
                <span className="tabular-nums">{number(entry.count)}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary/75"
                  style={{
                    width: `${(100 * entry.count) / Math.max(1, entries[0].count)}%`,
                  }}
                />
              </div>
            </li>
          ))}
        </ol>
      )}
      {entries.length > 30 && (
        <p className="mt-3 text-xs text-muted-foreground">
          {t("admin:desktopUsage.top", { count: 30, total: entries.length })}
        </p>
      )}
    </section>
  );

  return (
    <div className="flex flex-col gap-6">
      {header}
      <p className="text-xs text-muted-foreground">
        {formatTimestamp(report.since, lang)} —{" "}
        {formatTimestamp(report.until, lang)} ·{" "}
        {t("admin:desktopUsage.buckets")}
      </p>
      {report.rows.length === 0 && (
        <p role="status" className="rounded-lg border p-5">
          {t("admin:desktopUsage.empty")}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded-lg border bg-card p-5">
            <div className="text-2xl font-semibold tabular-nums">{value}</div>
            <div className="mt-1 text-sm text-muted-foreground">{label}</div>
          </div>
        ))}
      </div>
      <section className="rounded-lg border bg-card p-5">
        <h2 className="text-lg font-semibold">
          {t("admin:desktopUsage.activity")}
        </h2>
        <p className="mb-4 text-xs text-muted-foreground">
          {t("admin:desktopUsage.activityHint")}
        </p>
        <UsageActivityChart
          points={report.activity}
          lang={lang}
          label={t("admin:desktopUsage.activity")}
        />
      </section>
      <div className="grid gap-6 lg:grid-cols-2">
        {ranking(
          t("admin:desktopUsage.tools"),
          rankUsage(
            report.rows.filter((row) => row.event === "tool.activated"),
            (row) => row.tool,
          ),
          true,
        )}
        {ranking(
          t("admin:desktopUsage.effects"),
          rankUsage(
            report.rows.filter((row) => row.event === "effect.used"),
            (row) => `${row.tool} / ${row.feature}`,
          ),
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {t("admin:desktopUsage.measurementHint")}
      </p>
      <section className="rounded-lg border bg-card p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">
            {t("admin:desktopUsage.features")}
          </h2>
          <form action={base} className="flex gap-2">
            <input type="hidden" name="range" value={range} />
            <select
              key={tool}
              name="tool"
              defaultValue={tool}
              aria-label={t("admin:desktopUsage.tool")}
              className="rounded-md border bg-background px-3 py-2 text-sm"
            >
              <option value="">{t("admin:desktopUsage.allTools")}</option>
              {tools.map((value) => (
                <option key={value} value={value}>
                  {toolName(value)}
                </option>
              ))}
            </select>
            <button
              className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
              type="submit"
            >
              {t("admin:desktopUsage.apply")}
            </button>
          </form>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b text-muted-foreground">
              <tr>
                {["tool", "feature", "kind", "count"].map((key) => (
                  <th key={key} scope="col" className="p-2">
                    {t(`admin:desktopUsage.${key}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {features.slice(0, 100).map((entry) => {
                const [name, feature, event] = JSON.parse(
                  entry.label,
                ) as string[];
                return (
                  <tr key={entry.label} className="border-b last:border-0">
                    <td className="p-2">{toolName(name)}</td>
                    <td className="p-2 break-all">{feature}</td>
                    <td className="p-2">
                      {t(
                        `admin:desktopUsage.events.${event.replaceAll(".", "_")}`,
                      )}
                    </td>
                    <td className="p-2 tabular-nums">{number(entry.count)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {features.length === 0 && (
          <p className="mt-4 text-sm text-muted-foreground">
            {t("admin:desktopUsage.empty")}
          </p>
        )}
        {features.length > 100 && (
          <p className="mt-3 text-xs text-muted-foreground">
            {t("admin:desktopUsage.top", {
              count: 100,
              total: features.length,
            })}
          </p>
        )}
      </section>
      <section className="rounded-lg border bg-card p-5">
        <h2 className="mb-4 text-lg font-semibold">
          {t("admin:desktopUsage.operations")}
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b text-muted-foreground">
              <tr>
                {["feature", "outcome", "count", "averageMs"].map((key) => (
                  <th key={key} scope="col" className="p-2">
                    {t(`admin:desktopUsage.${key}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rankUsage(operations, (row) =>
                JSON.stringify([row.feature, row.outcome]),
              ).map((entry) => {
                const [feature, outcome] = JSON.parse(entry.label) as string[];
                const duration = operations
                  .filter(
                    (row) => row.feature === feature && row.outcome === outcome,
                  )
                  .reduce((sum, row) => sum + row.durationMs, 0);
                return (
                  <tr key={entry.label} className="border-b last:border-0">
                    <td className="p-2">{feature}</td>
                    <td className="p-2">{outcome}</td>
                    <td className="p-2">{number(entry.count)}</td>
                    <td className="p-2">{number(duration / entry.count)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      <div className="grid gap-6 lg:grid-cols-2">
        {ranking(
          t("admin:desktopUsage.os"),
          rankUsage(started, (row) => row.os),
        )}
        {ranking(
          t("admin:desktopUsage.version"),
          rankUsage(started, (row) => row.version),
        )}
      </div>
    </div>
  );
}
