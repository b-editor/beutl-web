import "server-only";
import { readBoundedResponseText } from "@beutl/api";
import type { DesktopUsageRange } from "./desktop-usage";
import {
  buildDesktopErrorReport,
  desktopErrorQuery,
  desktopErrorWindow,
  DESKTOP_ERROR_LIMIT,
  type DesktopErrorFilter,
  type DesktopErrorReport,
} from "./desktop-errors";

export type DesktopErrorResult =
  | { status: "ready"; report: DesktopErrorReport }
  | { status: "notConfigured" | "unavailable" };

export async function fetchDesktopErrors(
  range: DesktopUsageRange,
  level: DesktopErrorFilter,
  now = new Date(),
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch,
): Promise<DesktopErrorResult> {
  const endpoint = env.GRAFANA_LOKI_URL;
  const username = env.GRAFANA_LOKI_USER;
  const token = env.GRAFANA_LOKI_TOKEN;
  if (!endpoint || !username || !token) return { status: "notConfigured" };
  try {
    const base = new URL(endpoint);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash)
      return { status: "unavailable" };
    const window = desktopErrorWindow(range, now);
    const url = new URL(base.toString().replace(/\/$/, "") + "/loki/api/v1/query_range");
    url.search = new URLSearchParams({
      query: desktopErrorQuery(level),
      start: window.since.toISOString(),
      end: window.until.toISOString(),
      direction: "backward",
      // One extra entry distinguishes a full result from a truncated sample.
      limit: String(DESKTOP_ERROR_LIMIT + 1),
    }).toString();
    const response = await fetcher(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`,
        Accept: "application/json",
        "X-Loki-Response-Encoding-Flags": "categorize-labels",
      },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("Log backend unavailable");
    const data: unknown = JSON.parse(
      await readBoundedResponseText(response, 8 * 1024 * 1024, "Desktop error report"),
    );
    return { status: "ready", report: buildDesktopErrorReport(data, window) };
  } catch {
    // Neither upstream responses nor fetch errors (which can contain URLs or
    // credentials) belong in the rendered report or application logs.
    console.error("Desktop error report failed");
    return { status: "unavailable" };
  }
}
