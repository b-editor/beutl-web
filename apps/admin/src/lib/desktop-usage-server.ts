import "server-only";
import { readBoundedResponseText } from "@beutl/api";
import {
  buildUsageReport,
  mergeUsageReports,
  sessionUsageQuery,
  usageQuery,
  usageWindows,
  type DesktopUsageRange,
  type UsageReport,
} from "./desktop-usage";

export type UsageReportResult =
  | { status: "ready"; report: UsageReport }
  | { status: "notConfigured" | "unavailable" };

export async function fetchDesktopUsage(
  range: DesktopUsageRange,
  now = new Date(),
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch,
): Promise<UsageReportResult> {
  const endpoint = env.GRAFANA_TEMPO_URL;
  const username = env.GRAFANA_TEMPO_USER;
  const token = env.GRAFANA_TEMPO_TOKEN;
  if (!endpoint || !username || !token) return { status: "notConfigured" };
  try {
    const base = new URL(endpoint);
    if (
      base.protocol !== "https:" ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      return { status: "unavailable" };
    const windows = usageWindows(range, now);
    const reports: UsageReport[] = [];
    const deadline = AbortSignal.timeout(20_000);
    // At most two requests in flight. Grafana Cloud's default metrics range
    // limit is 24h; a week is seven disjoint queries, not a silently truncated one.
    for (const window of windows) {
      const fetchQuery = async (
        measure: "count" | "duration_ms",
        query: string,
      ) => {
        const url = new URL(
          base.toString().replace(/\/$/, "") + "/api/metrics/query_range",
        );
        url.search = new URLSearchParams({
          q: query,
          start: String(window.start),
          end: String(window.end),
          step: `${window.step}s`,
        }).toString();
        const response = await fetcher(url, {
          headers: {
            Authorization: `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`,
            Accept: "application/json",
          },
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]),
        });
        if (!response.ok) throw new Error("Usage backend unavailable");
        const data: unknown = JSON.parse(
          await readBoundedResponseText(
            response,
            8 * 1024 * 1024,
            "Usage report",
          ),
        );
        return { window, measure, data };
      };
      const results = await Promise.all(
        (["count", "duration_ms"] as const).map((measure) =>
          fetchQuery(measure, usageQuery(measure)),
        ),
      );
      results.push(await fetchQuery("count", sessionUsageQuery()));
      // Release each day's raw response before reading the next. Keeping up to
      // twenty-one 8 MiB responses would exhaust a Worker merely to render a week.
      reports.push(buildUsageReport([window], results));
    }
    return { status: "ready", report: mergeUsageReports(reports) };
  } catch {
    // Backend errors and credentials must never be rendered or logged in the browser.
    return { status: "unavailable" };
  }
}
