import type { DesktopUsageRange } from "./desktop-usage";

export const DESKTOP_ERROR_LEVELS = ["error", "critical", "fatal"] as const;
export type DesktopErrorLevel = (typeof DESKTOP_ERROR_LEVELS)[number];
export type DesktopErrorFilter = DesktopErrorLevel | "all";
export const DESKTOP_ERROR_LIMIT = 200;

export type DesktopError = {
  timestampNs: string;
  timestampMs: number;
  level: DesktopErrorLevel;
  template: string;
  scope: string;
  version: string;
  os: string;
  exceptionType: string;
  message: string;
  stackTrace: string;
  context: Record<string, string>;
};
export type DesktopErrorGroup = {
  key: string;
  entries: DesktopError[];
};
export type DesktopErrorReport = {
  since: Date;
  until: Date;
  oldest: Date | null;
  newest: Date | null;
  total: number;
  levels: Record<DesktopErrorLevel, number>;
  groups: DesktopErrorGroup[];
  truncated: boolean;
};

export function parseDesktopErrorFilter(value: unknown): DesktopErrorFilter {
  return DESKTOP_ERROR_LEVELS.includes(value as DesktopErrorLevel)
    ? (value as DesktopErrorLevel)
    : "all";
}

export function desktopErrorQuery(level: DesktopErrorFilter): string {
  const filter = parseDesktopErrorFilter(level);
  return `{service_name="Beutl"} | detected_level=~"${filter === "all" ? "error|fatal|critical" : filter}"`;
}

export function desktopErrorWindow(range: DesktopUsageRange, now: Date) {
  const hours = { "1h": 1, "6h": 6, "24h": 24, "7d": 168 }[range];
  // Logs have no aggregate buckets. Include the current hour's failures.
  return {
    since: new Date(now.getTime() - hours * 3_600_000),
    until: now,
  };
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function stringMap(value: unknown): Record<string, string> {
  if (!object(value) || Object.values(value).some((v) => typeof v !== "string"))
    throw new Error("Invalid log metadata");
  return value as Record<string, string>;
}

// Select only diagnostic fields. Do not send IP addresses, location data or
// instance identifiers from the upstream metadata to the browser.
const CONTEXT_FIELDS = [
  "Channel",
  "Package",
  "PackageName",
  "Frame",
  "FailureId",
  "UseOnionSkin",
  "Count",
  "IsTerminating",
] as const;

export function parseDesktopErrors(value: unknown): DesktopError[] {
  if (
    !object(value) ||
    value.status !== "success" ||
    !object(value.data) ||
    value.data.resultType !== "streams" ||
    !Array.isArray(value.data.result)
  )
    throw new Error("Invalid log response");

  const entries: DesktopError[] = [];
  for (const stream of value.data.result) {
    if (!object(stream) || !Array.isArray(stream.values)) throw new Error("Invalid log stream");
    const labels = stringMap(stream.stream);
    if (labels.service_name !== "Beutl") throw new Error("Unexpected log service");
    for (const item of stream.values) {
      if (
        !Array.isArray(item) ||
        item.length < 2 ||
        item.length > 3 ||
        typeof item[0] !== "string" ||
        !/^\d{1,20}$/.test(item[0]) ||
        typeof item[1] !== "string" ||
        entries.length >= DESKTOP_ERROR_LIMIT + 1
      )
        throw new Error("Invalid log entry");
      // categorize-labels places metadata in the third tuple element. Older
      // responses promote metadata to stream labels; support those as well.
      const extra = item[2];
      const metadata =
        extra === undefined
          ? {}
          : stringMap(
              object(extra) && "structuredMetadata" in extra ? extra.structuredMetadata : extra,
            );
      const fields = { ...labels, ...metadata };
      const timestampMs = Number(BigInt(item[0]) / BigInt(1_000_000));
      if (!Number.isSafeInteger(timestampMs) || !Number.isFinite(new Date(timestampMs).getTime()))
        throw new Error("Invalid log timestamp");
      const level = [fields.severity_text, fields.detected_level]
        .map((v) => v?.toLowerCase())
        .find((v) => DESKTOP_ERROR_LEVELS.includes(v as DesktopErrorLevel)) as
        | DesktopErrorLevel
        | undefined;
      if (!level) throw new Error("Missing error severity");
      const relay = fields.Message ?? "";
      const exceptionType =
        fields.exception_type || relay.match(/(?:^|\n)([\w.`+]+Exception)(?::|\r?$)/m)?.[1] || "";
      entries.push({
        timestampNs: item[0],
        timestampMs,
        level,
        template: item[1],
        scope: fields.scope_name ?? "",
        version: fields.service_version ?? "",
        os: fields.os_name || fields.os_type || "",
        exceptionType,
        message: fields.exception_message || relay,
        stackTrace: fields.exception_stacktrace || (/^\s+at /m.test(relay) ? relay : ""),
        context: Object.fromEntries(
          CONTEXT_FIELDS.filter((key) => fields[key] !== undefined).map((key) => [
            key,
            fields[key],
          ]),
        ),
      });
    }
  }
  return entries.sort((a, b) => {
    const left = BigInt(a.timestampNs),
      right = BigInt(b.timestampNs);
    return left > right ? -1 : left < right ? 1 : 0;
  });
}

export function buildDesktopErrorReport(
  value: unknown,
  window: { since: Date; until: Date },
): DesktopErrorReport {
  const parsed = parseDesktopErrors(value);
  const entries = parsed.slice(0, DESKTOP_ERROR_LIMIT);
  const groups = new Map<string, DesktopErrorGroup>();
  const levels = { error: 0, critical: 0, fatal: 0 };
  for (const entry of entries) {
    // Stdout relays reuse {Channel} {Message} for unrelated failures. Use the
    // exception type, or the first message line when no exception was logged.
    const relayKey = entry.template.includes("{Message}")
      ? entry.exceptionType || entry.message.split(/\r?\n/, 1)[0]
      : "";
    const key = JSON.stringify([entry.template, entry.scope, entry.exceptionType, relayKey]);
    const group = groups.get(key) ?? { key, entries: [] };
    group.entries.push(entry);
    groups.set(key, group);
    levels[entry.level]++;
  }
  return {
    ...window,
    oldest: entries.length ? new Date(entries[entries.length - 1].timestampMs) : null,
    newest: entries.length ? new Date(entries[0].timestampMs) : null,
    total: entries.length,
    levels,
    groups: [...groups.values()].sort(
      (a, b) =>
        b.entries.length - a.entries.length || b.entries[0].timestampMs - a.entries[0].timestampMs,
    ),
    truncated: parsed.length > DESKTOP_ERROR_LIMIT,
  };
}
