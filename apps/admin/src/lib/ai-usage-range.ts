// Aggregation windows offered by the AI usage report. Values are part of the
// page URL, so they are validated here rather than trusted from the query string.

export const AI_USAGE_RANGES = ["24h", "7d", "30d", "90d"] as const;

export type AiUsageRange = (typeof AI_USAGE_RANGES)[number];

export const DEFAULT_AI_USAGE_RANGE: AiUsageRange = "7d";

const HOUR_MS = 60 * 60 * 1000;

const RANGE_MS: Record<AiUsageRange, number> = {
  "24h": 24 * HOUR_MS,
  "7d": 7 * 24 * HOUR_MS,
  "30d": 30 * 24 * HOUR_MS,
  "90d": 90 * 24 * HOUR_MS,
};

export function isAiUsageRange(value: unknown): value is AiUsageRange {
  return (
    typeof value === "string" &&
    (AI_USAGE_RANGES as readonly string[]).includes(value)
  );
}

export function parseAiUsageRange(value: unknown): AiUsageRange {
  return isAiUsageRange(value) ? value : DEFAULT_AI_USAGE_RANGE;
}

export function aiUsageRangeStart(range: AiUsageRange, now: Date): Date {
  return new Date(now.getTime() - RANGE_MS[range]);
}
