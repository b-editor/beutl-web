import { describe, expect, it, vi } from "vitest";
import {
  buildUsageReport,
  mergeUsageReports,
  parseDesktopUsageRange,
  parseUsageSeries,
  rankUsage,
  sessionUsageQuery,
  usageQuery,
  usageWindows,
  USAGE_PREFIX,
} from "../../apps/admin/src/lib/desktop-usage";
import { fetchDesktopUsage } from "../../apps/admin/src/lib/desktop-usage-server";

vi.mock("@beutl/api", () => ({
  readBoundedResponseText: async (response: Response) => response.text(),
}));

const NOW = new Date("2026-10-01T12:34:00Z");
const env = {
  GRAFANA_TEMPO_URL: "https://tempo.example.test/tempo",
  GRAFANA_TEMPO_USER: "tenant",
  GRAFANA_TEMPO_TOKEN: "private-token",
};
const window = usageWindows("1h", NOW)[0];
function reply(
  event = "tool.command",
  feature = "CommitCommand",
  value = 7,
  timestampMs = window.end * 1000,
) {
  return {
    series: [
      {
        labels: [
          ...Object.entries({
            event,
            feature,
            tool: "VersionControl",
            outcome: "",
          }).map(([key, text]) => ({
            key: USAGE_PREFIX + key,
            value: { stringValue: text },
          })),
          { key: "resource.os.type", value: { stringValue: "linux" } },
          { key: "resource.service.version", value: { stringValue: "2.0.0" } },
        ],
        samples: [{ timestampMs: String(timestampMs), value }],
      },
    ],
    metrics: { totalJobs: 2, completedJobs: 2 },
  };
}

describe("desktop usage metrics", () => {
  it("keeps every query within Tempo's five grouping attributes and separates session starts", () => {
    const queries = [
      usageQuery("count"),
      usageQuery("duration_ms"),
      sessionUsageQuery(),
    ];
    for (const query of queries) {
      const groups = query.match(/ by \((.*)\)$/)?.[1].split(",");
      expect(groups).toBeDefined();
      expect(groups!.length).toBeLessThanOrEqual(5);
    }
    expect(queries[0]).toContain('span.beutl.usage.event != "session.started"');
    expect(queries[1]).toContain('span.beutl.usage.event != "session.started"');
    expect(queries[2]).toContain('span.beutl.usage.event = "session.started"');
    expect(queries[2]).toContain("resource.os.type, resource.service.version");
  });
  it("validates ranges and splits a week into disjoint complete 24-hour ranges", () => {
    expect(parseDesktopUsageRange("unbounded")).toBe("24h");
    const windows = usageWindows("7d", NOW);
    expect(windows).toHaveLength(7);
    expect(
      windows.every(
        (entry, i) =>
          entry.end - entry.start === 86400 &&
          (!i || windows[i - 1].end === entry.start),
      ),
    ).toBe(true);
    expect(windows.at(-1)?.end).toBe(
      new Date("2026-10-01T12:00:00Z").getTime() / 1000,
    );
  });

  it("sums batched counts instead of counting spans and merges OS/version breakdowns", () => {
    const linux = reply();
    const other = reply("tool.command", "CommitCommand", 3);
    other.series[0].labels.find(
      (label) => label.key === "resource.os.type",
    )!.value.stringValue = "windows";
    const report = buildUsageReport(
      [window],
      [
        {
          window,
          measure: "count",
          data: { series: [...linux.series, ...other.series] },
        },
        {
          window,
          measure: "duration_ms",
          data: reply("tool.command", "CommitCommand", 1400),
        },
      ],
    );
    expect(rankUsage(report.rows, (row) => row.feature)).toEqual([
      { label: "CommitCommand", count: 10 },
    ]);
    expect(report.rows[0].durationMs).toBe(1400);
    expect(report.activity.at(-1)?.count).toBe(10);
    expect(usageQuery("count")).toContain(
      "sum_over_time(span.beutl.usage.count)",
    );
    expect(usageQuery("count")).toContain('resource.service.name = "Beutl"');
  });

  it("does not count heartbeat or effect inventory as user activity", () => {
    const report = buildUsageReport(
      [window],
      [
        { window, measure: "count", data: reply("session.heartbeat", "", 4) },
        { window, measure: "count", data: reply("effect.used", "Blur", 3) },
      ],
    );
    expect(report.activity.every((point) => point.count === 0)).toBe(true);
  });

  it("ignores padding on both sides of a chunk and keeps the right boundary", () => {
    const data = reply();
    data.series[0].samples = [
      { timestampMs: String(window.start * 1000), value: 999 },
      { timestampMs: String(window.end * 1000), value: 5 },
      { timestampMs: String((window.end + window.step) * 1000), value: 999 },
    ];
    expect(
      buildUsageReport([window], [{ window, measure: "count", data }]).rows[0]
        .count,
    ).toBe(5);
  });

  it("merges day reports without losing outcomes or double-counting time buckets", () => {
    const first = buildUsageReport(
      [window],
      [{ window, measure: "count", data: reply("operation", "export", 4) }],
    );
    const nextWindow = { ...window, start: window.end, end: window.end + 3600 };
    const second = buildUsageReport(
      [nextWindow],
      [
        {
          window: nextWindow,
          measure: "count",
          data: reply("operation", "export", 2, nextWindow.end * 1000),
        },
      ],
    );
    const report = mergeUsageReports([first, second]);
    expect(report.rows[0].count).toBe(6);
    expect(report.activity).toHaveLength(
      first.activity.length + second.activity.length,
    );
    expect(report.until).toEqual(new Date(nextWindow.end * 1000));
  });

  it("rejects partial and invalid responses instead of reporting zero usage", () => {
    for (const data of [
      null,
      { status: "PARTIAL" },
      { status: 1 },
      { metrics: { totalJobs: 2, completedJobs: 1 } },
      { series: "invalid" },
      { error: "failure" },
    ]) {
      expect(() => parseUsageSeries(data)).toThrow();
    }
    const data = reply();
    data.series[0].samples[0].value = -1;
    expect(() => parseUsageSeries(data)).toThrow();
  });

  it("accepts an empty proto response and NaN empty aggregate buckets", () => {
    expect(parseUsageSeries({})).toEqual([]);
    const data = reply();
    (data.series[0].samples[0] as { value: unknown }).value = "NaN";
    expect(parseUsageSeries(data)[0].samples[0].value).toBe(0);
  });

  it("ignores named future events without rejecting an otherwise valid report", () => {
    const data = reply("future.event");
    data.series.push(...reply().series);
    const report = buildUsageReport(
      [window],
      [{ window, measure: "count", data }],
    );
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].event).toBe("tool.command");
  });

  it("keeps tools and features separate even when two tabs use the same command", () => {
    const data = reply("tool.command", "Refresh");
    const second = reply("tool.command", "Refresh");
    second.series[0].labels.find(
      (label) => label.key === USAGE_PREFIX + "tool",
    )!.value.stringValue = "FileBrowser";
    const report = buildUsageReport(
      [window],
      [
        {
          window,
          measure: "count",
          data: { series: [...data.series, ...second.series] },
        },
      ],
    );
    expect(report.rows).toHaveLength(2);
    expect(new Set(report.rows.map((row) => row.tool))).toEqual(
      new Set(["VersionControl", "FileBrowser"]),
    );
  });
});

describe("server-only Grafana queries", () => {
  it("does not call the backend until all credentials are configured", async () => {
    const fetcher = vi.fn();
    expect(await fetchDesktopUsage("1h", NOW, {}, fetcher)).toEqual({
      status: "notConfigured",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses authenticated, uncached, bounded queries with redirect refusal", async () => {
    const fetcher = vi.fn(async () => Response.json(reply()));
    expect((await fetchDesktopUsage("1h", NOW, env, fetcher)).status).toBe(
      "ready",
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
    const [url, options] = fetcher.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(url.pathname).toBe("/tempo/api/metrics/query_range");
    expect(url.searchParams.get("q")).toContain("sum_over_time");
    expect(options).toMatchObject({
      cache: "no-store",
      redirect: "manual",
      headers: {
        Authorization: `Basic ${Buffer.from("tenant:private-token").toString("base64")}`,
      },
    });
  });

  it.each([301, 302, 303, 307, 308])(
    "rejects an HTTP %i redirect instead of following it or parsing its body",
    async (status) => {
      const fetcher = vi.fn(async () =>
        new Response(JSON.stringify(reply()), {
          status,
          headers: { Location: "https://other.example.test/metrics" },
        }),
      );
      expect(await fetchDesktopUsage("1h", NOW, env, fetcher)).toEqual({
        status: "unavailable",
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
      for (const [input, options] of fetcher.mock.calls as unknown as [
        URL,
        RequestInit,
      ][]) {
        expect(input.origin).toBe("https://tempo.example.test");
        expect(options.redirect).toBe("manual");
      }
    },
  );

  it("reports unavailable when any chunk fails and never returns credentials or raw errors", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response("private-token upstream details", { status: 403 }),
    );
    expect(await fetchDesktopUsage("7d", NOW, env, fetcher)).toEqual({
      status: "unavailable",
    });
  });

  it("reports partial data as unavailable", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ status: "PARTIAL", series: [] }),
    );
    expect(await fetchDesktopUsage("1h", NOW, env, fetcher)).toEqual({
      status: "unavailable",
    });
  });

  it.each(["missing", "empty"])(
    "reports a %s event label as unavailable instead of empty usage",
    async (kind) => {
      const data = reply(kind === "empty" ? "" : "tool.command");
      if (kind === "missing") {
        data.series[0].labels = data.series[0].labels.filter(
          (label) => label.key !== USAGE_PREFIX + "event",
        );
      }
      const fetcher = vi.fn(async () => Response.json(data));
      expect(await fetchDesktopUsage("1h", NOW, env, fetcher)).toEqual({
        status: "unavailable",
      });
    },
  );

  it("rejects HTTP and URL-embedded credentials before sending the read token", async () => {
    const fetcher = vi.fn();
    for (const url of [
      "http://tempo.test",
      "https://user:pass@tempo.test",
      "https://tempo.test/?token=value",
    ]) {
      expect(
        await fetchDesktopUsage(
          "1h",
          NOW,
          { ...env, GRAFANA_TEMPO_URL: url },
          fetcher,
        ),
      ).toEqual({ status: "unavailable" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("queries all seven days without exceeding 24h per request", async () => {
    const fetcher = vi.fn(async () => Response.json({}));
    expect((await fetchDesktopUsage("7d", NOW, env, fetcher)).status).toBe(
      "ready",
    );
    expect(fetcher).toHaveBeenCalledTimes(21);
  });

  it.each([
    { delay: 2_000, status: "ready", requests: 21 },
    { delay: 11_000, status: "unavailable", requests: 2 },
  ])(
    "keeps weekly queries bounded with $delay ms responses",
    async ({ delay, status, requests }) => {
      vi.useFakeTimers();
      // Node's native AbortSignal.timeout uses an internal timer, so route it
      // through the fake clock while retaining real AbortSignal.any behavior.
      const timeout = vi
        .spyOn(AbortSignal, "timeout")
        .mockImplementation((ms) => {
          const controller = new AbortController();
          setTimeout(
            () =>
              controller.abort(new DOMException("Timed out", "TimeoutError")),
            ms,
          );
          return controller.signal;
        });
      let active = 0;
      let maximumActive = 0;
      const fetcher = vi.fn(
        (_input: RequestInfo | URL, options?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            const signal = options!.signal!;
            signal.throwIfAborted();
            maximumActive = Math.max(maximumActive, ++active);
            const timer = setTimeout(() => {
              signal.removeEventListener("abort", onAbort);
              active--;
              resolve(Response.json({}));
            }, delay);
            function onAbort() {
              clearTimeout(timer);
              active--;
              reject(signal.reason);
            }
            signal.addEventListener("abort", onAbort, { once: true });
          }),
      );
      try {
        const pending = fetchDesktopUsage("7d", NOW, env, fetcher);
        // Seven days need 28 seconds at 2 seconds per request, even with the
        // count/duration pairs in parallel. No individual request is slow.
        await vi.advanceTimersByTimeAsync(28_000);
        expect((await pending).status).toBe(status);
        expect(fetcher).toHaveBeenCalledTimes(requests);
        expect(maximumActive).toBe(2);
        expect(active).toBe(0);
      } finally {
        timeout.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it("retains session breakdowns and operation durations without counting sessions twice", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const query = new URL(String(input)).searchParams.get("q")!;
      const groups = query
        .match(/ by \((.*)\)$/)![1]
        .split(",")
        .map((value) => value.trim());
      // Enforce the upstream constraint instead of accepting any query as the
      // earlier fetch stub did. Responses only contain the requested labels.
      if (groups.length > 5)
        return new Response("unsupported metrics group by", { status: 400 });
      const sessions = query.includes('event = "session.started"');
      if (!sessions && !query.includes('event != "session.started"'))
        return new Response("overlapping queries", { status: 400 });
      const duration = query.includes(
        "sum_over_time(span.beutl.usage.duration_ms)",
      );
      const rows = sessions
        ? [
            {
              event: "session.started",
              os: "linux",
              version: "2.0",
              count: 3,
              durationMs: 0,
            },
            {
              event: "session.started",
              os: "windows",
              version: "2.1",
              count: 2,
              durationMs: 0,
            },
          ]
        : [
            {
              event: "operation",
              feature: "export",
              outcome: "succeeded",
              count: 4,
              durationMs: 8000,
            },
            {
              event: "operation",
              feature: "export",
              outcome: "failed",
              count: 1,
              durationMs: 500,
            },
            { event: "session.heartbeat", count: 6, durationMs: 180000 },
          ];
      return Response.json({
        series: rows.map((row) => {
          const attributes: Record<string, string> = {
            [USAGE_PREFIX + "event"]: row.event,
            [USAGE_PREFIX + "tool"]: "",
            [USAGE_PREFIX + "feature"]: "feature" in row ? row.feature : "",
            [USAGE_PREFIX + "outcome"]: "outcome" in row ? row.outcome : "",
            "resource.os.type": "os" in row ? row.os : "",
            "resource.service.version": "version" in row ? row.version : "",
          };
          return {
            labels: groups.map((key) => ({
              key,
              value: { stringValue: attributes[key] },
            })),
            samples: [
              {
                timestampMs: String(window.end * 1000),
                value: duration ? row.durationMs : row.count,
              },
            ],
          };
        }),
      });
    });
    const result = await fetchDesktopUsage("1h", NOW, env, fetcher);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected report");
    const sessions = result.report.rows.filter(
      (row) => row.event === "session.started",
    );
    expect(sessions.reduce((sum, row) => sum + row.count, 0)).toBe(5);
    expect(rankUsage(sessions, (row) => row.os)).toEqual([
      { label: "linux", count: 3 },
      { label: "windows", count: 2 },
    ]);
    expect(rankUsage(sessions, (row) => row.version)).toEqual([
      { label: "2.0", count: 3 },
      { label: "2.1", count: 2 },
    ]);
    expect(
      result.report.rows.find((row) => row.outcome === "succeeded"),
    ).toMatchObject({ count: 4, durationMs: 8000 });
    expect(
      result.report.rows.find((row) => row.outcome === "failed"),
    ).toMatchObject({ count: 1, durationMs: 500 });
    expect(
      result.report.rows.find((row) => row.event === "session.heartbeat"),
    ).toMatchObject({ durationMs: 180000 });
    expect(
      result.report.activity.reduce((sum, point) => sum + point.count, 0),
    ).toBe(5);
  });
});
