// OTLP schema v1: one span represents a minute's aggregated events, not one
// user action. Always sum beutl.usage.count, never count the summary spans.
export const DESKTOP_USAGE_RANGES = ["1h", "6h", "24h", "7d"] as const;
export type DesktopUsageRange = (typeof DESKTOP_USAGE_RANGES)[number];
export const USAGE_PREFIX = "span.beutl.usage.";
export const USAGE_EVENTS = [
  "session.started",
  "session.heartbeat",
  "session.ended",
  "operation",
  "playback.started",
  "tool.opened",
  "tool.activated",
  "tool.command",
  "tool.action",
  "tool.setting",
  "editor.edit",
  "editor.property",
  "editor.history",
  "effect.used",
] as const;
export type UsageEvent = (typeof USAGE_EVENTS)[number];

export type UsageRow = {
  event: UsageEvent;
  tool: string;
  feature: string;
  outcome: string;
  os: string;
  version: string;
  count: number;
  durationMs: number;
};
export type UsagePoint = { timestampMs: number; count: number };
export type UsageReport = {
  rows: UsageRow[];
  activity: UsagePoint[];
  since: Date;
  until: Date;
};
export type UsageWindow = { start: number; end: number; step: number };

export function parseDesktopUsageRange(value: unknown): DesktopUsageRange {
  return DESKTOP_USAGE_RANGES.includes(value as DesktopUsageRange)
    ? (value as DesktopUsageRange)
    : "24h";
}

export function usageWindows(
  range: DesktopUsageRange,
  now: Date,
): UsageWindow[] {
  const hours = { "1h": 1, "6h": 6, "24h": 24, "7d": 168 }[range];
  const step = hours <= 6 ? 300 : 3600;
  // Tempo rounds ranges to steps. Use complete buckets so the label and totals
  // describe exactly the queried range and adjacent 24h queries never overlap.
  const end = Math.floor(now.getTime() / 1000 / step) * step;
  const windows: UsageWindow[] = [];
  for (let start = end - hours * 3600; start < end; start += 86400) {
    windows.push({ start, end: Math.min(start + 86400, end), step });
  }
  return windows;
}

export function usageQuery(measure: "count" | "duration_ms"): string {
  // Tempo supports at most five grouping attributes. Session starts have their
  // own OS/version query and must be excluded here to avoid counting them twice.
  return (
    `{ resource.service.name = "Beutl" && ${USAGE_PREFIX}schema_version = 1 && ${USAGE_PREFIX}event != "session.started" }` +
    ` | sum_over_time(${USAGE_PREFIX}${measure}) by (` +
    ["event", "tool", "feature", "outcome"]
      .map((key) => USAGE_PREFIX + key)
      .join(", ") +
    ")"
  );
}

export function sessionUsageQuery(): string {
  return (
    `{ resource.service.name = "Beutl" && ${USAGE_PREFIX}schema_version = 1 && ${USAGE_PREFIX}event = "session.started" }` +
    ` | sum_over_time(${USAGE_PREFIX}count) by (${USAGE_PREFIX}event, resource.os.type, resource.service.version)`
  );
}

type ParsedSeries = {
  labels: Record<string, string>;
  samples: { timestampMs: number; value: number }[];
};
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The Tempo HTTP API uses protobuf JSON (series/labels/samples), not the
// Prometheus data.result format. A malformed/partial reply is never an empty report.
export function parseUsageSeries(value: unknown): ParsedSeries[] {
  if (
    !object(value) ||
    (value.status !== undefined &&
      value.status !== "COMPLETE" &&
      value.status !== 0)
  ) {
    throw new Error("Incomplete usage response");
  }
  if (object(value.metrics)) {
    const { totalJobs, completedJobs } = value.metrics;
    if (
      totalJobs !== undefined &&
      Number(totalJobs) > Number(completedJobs ?? 0)
    )
      throw new Error("Incomplete usage response");
  }
  if ("error" in value || "errors" in value)
    throw new Error("Invalid usage response");
  const series = value.series ?? [];
  if (!Array.isArray(series) || series.length > 4096)
    throw new Error("Invalid usage series");
  return series.map((item) => {
    if (
      !object(item) ||
      !Array.isArray(item.labels) ||
      !Array.isArray(item.samples)
    )
      throw new Error("Invalid usage series");
    const labels: Record<string, string> = Object.create(null);
    for (const label of item.labels) {
      if (
        !object(label) ||
        typeof label.key !== "string" ||
        !object(label.value)
      )
        throw new Error("Invalid usage label");
      const text = label.value.stringValue;
      if (typeof text !== "string" || text.length > 256)
        throw new Error("Invalid usage label");
      labels[label.key] = text;
    }
    if (item.samples.length > 2048) throw new Error("Too many usage samples");
    const samples = item.samples.map((sample) => {
      if (!object(sample)) throw new Error("Invalid usage sample");
      // Proto int64 timestamps are JSON strings; the default numeric value 0
      // may be omitted. NaN denotes an empty aggregate bucket in Tempo.
      const timestampMs = Number(sample.timestampMs);
      const number = sample.value === "NaN" ? 0 : (sample.value ?? 0);
      if (
        !Number.isSafeInteger(timestampMs) ||
        typeof number !== "number" ||
        !Number.isFinite(number) ||
        number < 0
      ) {
        throw new Error("Invalid usage sample");
      }
      return { timestampMs, value: number };
    });
    return { labels, samples };
  });
}

export function buildUsageReport(
  windows: UsageWindow[],
  replies: {
    window: UsageWindow;
    measure: "count" | "duration_ms";
    data: unknown;
  }[],
): UsageReport {
  const rows = new Map<string, UsageRow>();
  const activity = new Map<number, number>();
  for (const window of windows) {
    for (
      let time = window.start + window.step;
      time <= window.end;
      time += window.step
    )
      activity.set(time * 1000, 0);
  }
  for (const reply of replies) {
    for (const series of parseUsageSeries(reply.data)) {
      const get = (key: string) => series.labels[USAGE_PREFIX + key] ?? "";
      const event = get("event") as UsageEvent;
      if (!USAGE_EVENTS.includes(event)) continue;
      const dimensions = {
        event,
        tool: get("tool"),
        feature: get("feature"),
        outcome: get("outcome"),
        os: series.labels["resource.os.type"] ?? "Unknown",
        version: series.labels["resource.service.version"] ?? "Unknown",
      };
      const key = JSON.stringify(dimensions);
      const row = rows.get(key) ?? { ...dimensions, count: 0, durationMs: 0 };
      for (const sample of series.samples) {
        // Tempo buckets are right-closed (start, end]. Reject padding outside
        // this chunk, including a neighbor's boundary, before summing.
        if (
          sample.timestampMs <= reply.window.start * 1000 ||
          sample.timestampMs > reply.window.end * 1000
        )
          continue;
        if (reply.measure === "count") {
          row.count += sample.value;
          if (
            !event.startsWith("session.") &&
            event !== "tool.opened" &&
            event !== "effect.used"
          ) {
            activity.set(
              sample.timestampMs,
              (activity.get(sample.timestampMs) ?? 0) + sample.value,
            );
          }
        } else row.durationMs += sample.value;
      }
      rows.set(key, row);
    }
  }
  return {
    rows: [...rows.values()]
      .filter((row) => row.count > 0)
      .sort((a, b) => b.count - a.count),
    activity: [...activity]
      .sort(([a], [b]) => a - b)
      .map(([timestampMs, count]) => ({ timestampMs, count })),
    since: new Date(windows[0].start * 1000),
    until: new Date(windows[windows.length - 1].end * 1000),
  };
}

export function rankUsage(
  rows: UsageRow[],
  key: (row: UsageRow) => string,
): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows)
    counts.set(key(row), (counts.get(key(row)) ?? 0) + row.count);
  return [...counts]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function mergeUsageReports(reports: UsageReport[]): UsageReport {
  const rows = new Map<string, UsageRow>();
  for (const report of reports) {
    for (const row of report.rows) {
      const { count, durationMs, ...dimensions } = row;
      const key = JSON.stringify(dimensions);
      const previous = rows.get(key);
      rows.set(key, {
        ...dimensions,
        count: count + (previous?.count ?? 0),
        durationMs: durationMs + (previous?.durationMs ?? 0),
      });
    }
  }
  return {
    rows: [...rows.values()].sort((a, b) => b.count - a.count),
    activity: reports.flatMap((report) => report.activity),
    since: reports[0].since,
    until: reports[reports.length - 1].until,
  };
}
