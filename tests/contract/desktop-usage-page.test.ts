import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "../../apps/admin/node_modules/react-dom/server";
import { DesktopUsageView } from "../../apps/admin/src/app/[lang]/admin/usage/view";
import Page from "../../apps/admin/src/app/[lang]/admin/usage/page";
import type {
  UsageReport,
  UsageRow,
} from "../../apps/admin/src/lib/desktop-usage";

const guards = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  fetchUsage: vi.fn(),
}));
vi.mock("../../apps/admin/src/lib/auth-guard", () => ({
  requireAdmin: guards.requireAdmin,
}));
vi.mock("../../apps/admin/src/lib/desktop-usage-server", () => ({
  fetchDesktopUsage: guards.fetchUsage,
}));

const row = (
  event: UsageRow["event"],
  tool: string,
  feature: string,
  count: number,
  durationMs = 0,
  outcome = "",
): UsageRow => ({
  event,
  tool,
  feature,
  count,
  durationMs,
  outcome,
  os: "linux",
  version: "2.0.0",
});
const report: UsageReport = {
  since: new Date("2026-09-30T12:00:00Z"),
  until: new Date("2026-10-01T12:00:00Z"),
  activity: Array.from({ length: 24 }, (_, i) => ({
    timestampMs: Date.UTC(2026, 8, 30, 13 + i),
    count: [20, 60, 34, 72, 96, 180, 151, 94][i % 8],
  })),
  rows: [
    row("session.started", "", "", 42),
    row("session.heartbeat", "", "", 240, 72_000_000),
    row("tool.activated", "ColorScopes", "", 128),
    row("tool.activated", "Timeline", "", 320),
    row("tool.activated", "VersionControl", "", 72),
    row("tool.activated", "NodeGraph", "", 64),
    row("tool.setting", "ColorScopes", "SelectedScopeType.Vectorscope", 55),
    row("tool.command", "VersionControl", "CommitCommand", 38),
    row("editor.edit", "Timeline", "SplitElement", 92),
    row("editor.property", "ColorGrading", "ColorGrading.Exposure", 63),
    row("effect.used", "Video", "Blur", 24),
    row("effect.used", "Video", "ColorGrading", 18),
    row("effect.used", "Audio", "Equalizer", 8),
    row("operation", "", "export", 19, 38_000, "succeeded"),
    row("operation", "", "export", 1, 500, "failed"),
  ],
};

describe("desktop usage page", () => {
  it("requires admin access before making any Grafana request", async () => {
    guards.requireAdmin.mockRejectedValueOnce(new Error("redirect"));
    guards.fetchUsage.mockClear();
    await expect(
      Page({
        params: Promise.resolve({ lang: "ja" }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("redirect");
    expect(guards.fetchUsage).not.toHaveBeenCalled();
  });

  it("renders meaningful labels, counts and tool filters in both languages", async () => {
    for (const lang of ["ja", "en"]) {
      const html = renderToStaticMarkup(
        await DesktopUsageView({
          lang,
          range: "24h",
          result: { status: "ready", report },
        }),
      );
      expect(html).toContain("95% (19/20)");
      expect(html).toContain("ColorGrading.Exposure");
      expect(html).toContain("SelectedScopeType.Vectorscope");
      expect(html).toContain("tool=ColorScopes");
      expect(html).not.toContain("admin:desktopUsage");
      if (lang === "ja" && process.env.BEUTL_USAGE_PREVIEW) {
        mkdirSync(process.env.BEUTL_USAGE_PREVIEW, { recursive: true });
        writeFileSync(
          `${process.env.BEUTL_USAGE_PREVIEW}/index.html`,
          `<!doctype html><html lang="ja" class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body class="bg-background text-foreground antialiased"><main class="mx-auto max-w-7xl p-6"><p class="mb-4 text-sm text-muted-foreground">表示確認用のテストデータ</p>${html}</main></body></html>`,
        );
      }
    }
  });

  it("filters features to the selected tool without changing the overall statistics", async () => {
    const html = renderToStaticMarkup(
      await DesktopUsageView({
        lang: "ja",
        range: "24h",
        requestedTool: "ColorScopes",
        result: { status: "ready", report },
      }),
    );
    expect(html).toContain("SelectedScopeType.Vectorscope");
    expect(html).not.toContain("CommitCommand");
    expect(html).toContain("95% (19/20)");
  });

  it("distinguishes missing configuration, failed queries and genuine empty data", async () => {
    const config = renderToStaticMarkup(
      await DesktopUsageView({
        lang: "en",
        range: "24h",
        result: { status: "notConfigured" },
      }),
    );
    const failure = renderToStaticMarkup(
      await DesktopUsageView({
        lang: "en",
        range: "24h",
        result: { status: "unavailable" },
      }),
    );
    const empty = renderToStaticMarkup(
      await DesktopUsageView({
        lang: "en",
        range: "24h",
        result: { status: "ready", report: { ...report, rows: [] } },
      }),
    );
    expect(config).toContain("not configured");
    expect(failure).toContain("could not be loaded");
    expect(empty).toContain("No usage data");
    expect(empty).not.toContain("NaN");
  });
});
