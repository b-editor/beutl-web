import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDesktopErrorReport,
  desktopErrorQuery,
  desktopErrorWindow,
  DESKTOP_ERROR_LIMIT,
  parseDesktopErrorFilter,
  parseDesktopErrors,
} from "../../apps/admin/src/lib/desktop-errors";
import { fetchDesktopErrors } from "../../apps/admin/src/lib/desktop-errors-server";
import { ERROR_NOW, errorLogFixture, logEntry, logResponse } from "../fixtures/desktop-errors";

const env = {
  GRAFANA_LOKI_URL: "https://logs.example.test",
  GRAFANA_LOKI_USER: "logs-tenant",
  GRAFANA_LOKI_TOKEN: "private-read-token",
};
const window = desktopErrorWindow("7d", ERROR_NOW);
afterEach(() => vi.restoreAllMocks());

describe("desktop error reports", () => {
  it("parses real Loki metadata, groups templates and retains each occurrence's details", () => {
    const report = buildDesktopErrorReport(errorLogFixture, window);
    expect(report).toMatchObject({
      total: 5,
      levels: { error: 4, critical: 1, fatal: 0 },
      truncated: false,
    });
    expect(report.groups).toHaveLength(4);
    expect(report.groups[0].entries).toHaveLength(2);
    expect(report.groups[0].entries[0]).toMatchObject({ os: "Linux", context: { Frame: "129" } });
    expect(report.oldest?.getTime()).toBe(ERROR_NOW.getTime() - 300_000);
    expect(report.newest?.getTime()).toBe(ERROR_NOW.getTime() - 60_000);
    const relay = report.groups.find((g) => g.entries[0].scope === "FFmpegWorker")!.entries[0];
    expect(relay.exceptionType).toBe("Beutl.FFmpegIpc.FFmpegLibrariesNotFoundException");
    expect(relay.stackTrace).toContain("at Beutl.FFmpegWorker.FFmpegLoaderWorker.GetRootPath()");
    expect(report.groups.find((g) => g.entries[0].context.FailureId)?.entries[0].stackTrace).toBe(
      "",
    );
  });

  it("does not combine different exception types, sources or unrelated stdout errors", () => {
    const relay = {
      exception_type: "",
      exception_message: "",
      exception_stacktrace: "",
      scope_name: "FFmpegWorker",
    };
    const report = buildDesktopErrorReport(
      logResponse([
        logEntry(1),
        logEntry(2, { exception_type: "System.OutOfMemoryException" }),
        logEntry(3, { scope_name: "AnotherSource" }),
        logEntry(4, { ...relay, Message: "Codec not found" }, "{Channel} {Message}"),
        logEntry(5, { ...relay, Message: "Worker disconnected" }, "{Channel} {Message}"),
      ]),
      window,
    );
    expect(report.groups).toHaveLength(5);
  });

  it("handles promoted and flat metadata without exposing unrelated private attributes", () => {
    const entry = logEntry(1, { client_ip: "192.0.2.1", city: "Private city", lat: "1.23" });
    const fields = (entry[2] as { structuredMetadata: Record<string, string> }).structuredMetadata;
    for (const values of [
      [entry[0], entry[1]],
      [entry[0], entry[1], fields],
    ]) {
      const data = logResponse([values]);
      Object.assign(data.data.result[0].stream, fields);
      const parsed = parseDesktopErrors(data);
      expect(parsed[0].exceptionType).toBe("System.InvalidOperationException");
      expect(JSON.stringify(parsed)).not.toMatch(
        /192\.0\.2\.1|Private city|private-instance|client_ip/,
      );
    }
  });

  it("sorts nanosecond timestamps across streams and only flags a genuine extra record", () => {
    const data = logResponse(
      Array.from({ length: DESKTOP_ERROR_LIMIT }, (_, i) => logEntry(i + 1)),
    );
    expect(buildDesktopErrorReport(data, window).truncated).toBe(false);
    data.data.result.push({
      stream: { service_name: "Beutl", service_instance_id: "another" },
      values: [logEntry(0)],
    });
    const report = buildDesktopErrorReport(data, window);
    expect(report.total).toBe(200);
    expect(report.truncated).toBe(true);
    expect(report.oldest?.getTime()).toBe(ERROR_NOW.getTime() - 199_000);
    const sameMillisecond = logEntry(0);
    sameMillisecond[0] = String(BigInt(sameMillisecond[0] as string) + BigInt(1));
    expect(parseDesktopErrors(logResponse([logEntry(0), sameMillisecond]))[0].timestampNs).toBe(
      sameMillisecond[0],
    );
  });

  it("distinguishes valid empty logs from malformed or failed responses", () => {
    expect(buildDesktopErrorReport(logResponse(), window)).toMatchObject({
      total: 0,
      groups: [],
      oldest: null,
      newest: null,
    });
    for (const value of [
      {},
      { status: "error", data: { resultType: "streams", result: [] } },
      { status: "success", data: { resultType: "matrix", result: [] } },
      logResponse([["not-a-timestamp", "message"]]),
      logResponse([["99999999999999999999", "message"]]),
      logResponse([logEntry(1, { severity_text: "", detected_level: "" })]),
    ])
      expect(() => parseDesktopErrors(value)).toThrow();
  });

  it("uses bounded, current periods and allowlisted level filters", () => {
    expect(window.since.toISOString()).toBe("2026-10-06T01:44:28.000Z");
    expect(window.until).toEqual(ERROR_NOW);
    expect(desktopErrorWindow("1h", ERROR_NOW).since.toISOString()).toBe(
      "2026-10-13T00:44:28.000Z",
    );
    expect(parseDesktopErrorFilter('error" | json')).toBe("all");
    expect(desktopErrorQuery("all")).toBe(
      '{service_name="Beutl"} | detected_level=~"error|fatal|critical"',
    );
    expect(desktopErrorQuery("critical")).toBe(
      '{service_name="Beutl"} | detected_level=~"critical"',
    );
  });
});

describe("server-only Loki requests", () => {
  it("requires all three credentials before requesting logs", async () => {
    const fetcher = vi.fn();
    for (const key of Object.keys(env)) {
      expect(
        await fetchDesktopErrors("7d", "all", ERROR_NOW, { ...env, [key]: "" }, fetcher),
      ).toEqual({ status: "notConfigured" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("queries only the selected errors newest-first with private auth and no cache or redirects", async () => {
    const fetcher = vi.fn(async () => Response.json(errorLogFixture));
    const result = await fetchDesktopErrors("7d", "critical", ERROR_NOW, env, fetcher);
    expect(result.status).toBe("ready");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/loki/api/v1/query_range");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      query: desktopErrorQuery("critical"),
      start: window.since.toISOString(),
      end: ERROR_NOW.toISOString(),
      direction: "backward",
      limit: "201",
    });
    expect(options).toMatchObject({
      cache: "no-store",
      redirect: "manual",
      headers: {
        Authorization: `Basic ${Buffer.from("logs-tenant:private-read-token").toString("base64")}`,
        "X-Loki-Response-Encoding-Flags": "categorize-labels",
      },
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(result)).not.toContain("private-read-token");
  });

  it("rejects unsafe endpoints without sending credentials", async () => {
    const fetcher = vi.fn();
    for (const endpoint of [
      "http://logs.test",
      "https://user:pass@logs.test",
      "https://logs.test?token=secret",
      "https://logs.test#fragment",
    ]) {
      expect(
        await fetchDesktopErrors(
          "1h",
          "all",
          ERROR_NOW,
          { ...env, GRAFANA_LOKI_URL: endpoint },
          fetcher,
        ),
      ).toEqual({ status: "unavailable" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not expose failure bodies or follow redirects", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const status of [302, 403, 429, 500]) {
      const fetcher = vi.fn(
        async () =>
          new Response("private upstream body", {
            status,
            headers: { Location: "https://elsewhere.test" },
          }),
      );
      expect(await fetchDesktopErrors("1h", "all", ERROR_NOW, env, fetcher)).toEqual({
        status: "unavailable",
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    expect(JSON.stringify(log.mock.calls)).not.toContain("private upstream body");
  });

  it("bounds streamed responses and rejects invalid JSON instead of reporting no errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const response of [
      new Response("not-json"),
      Response.json({ status: "error" }),
      new Response(new Uint8Array(8 * 1024 * 1024 + 1)),
    ]) {
      expect(await fetchDesktopErrors("1h", "all", ERROR_NOW, env, async () => response)).toEqual({
        status: "unavailable",
      });
    }
  });
});
