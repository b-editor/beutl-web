import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "../../apps/admin/node_modules/react-dom/server";
import { DesktopErrorsView } from "../../apps/admin/src/app/[lang]/admin/usage/errors";
import {
  buildDesktopErrorReport,
  desktopErrorWindow,
} from "../../apps/admin/src/lib/desktop-errors";
import type { DesktopErrorResult } from "../../apps/admin/src/lib/desktop-errors-server";
import { ERROR_NOW, errorLogFixture, logEntry, logResponse } from "../fixtures/desktop-errors";

const window = desktopErrorWindow("7d", ERROR_NOW);
const report = buildDesktopErrorReport(errorLogFixture, window);
const render = async (lang: string, result: DesktopErrorResult) =>
  renderToStaticMarkup(await DesktopErrorsView({ lang, range: "7d", level: "all", result }));

function preview(name: string, lang: string, html: string) {
  const directory = process.env.BEUTL_ERRORS_PREVIEW;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    `${directory}/${name}.html`,
    `<!doctype html><html lang="${lang}" class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body class="bg-background text-foreground antialiased"><main class="mx-auto max-w-7xl p-6"><p class="mb-4 text-sm text-muted-foreground">表示確認用のテストデータ</p>${html}</main></body></html>`,
  );
}

describe("desktop error log page", () => {
  it("renders localized counts, per-occurrence diagnostics and both types of stack trace", async () => {
    for (const lang of ["ja", "en"]) {
      const html = await render(lang, { status: "ready", report });
      expect(html).not.toMatch(/admin:desktop|\{\{\w+\}\}/);
      expect(html).toContain("Error");
      expect(html).toContain("Critical");
      expect(html).toContain(lang === "ja" ? "2 件" : "2 records");
      expect(html).toContain("at Beutl.ViewModels.PlayerViewModel.Render()");
      expect(html).toContain("at Beutl.FFmpegWorker.FFmpegLoaderWorker.GetRootPath()");
      expect(html).toContain("unsupported-media");
      expect(html).toContain("2.0.0-preview.8");
      expect(html).toContain("Linux");
      expect(html).toContain("JST");
      expect(html).toContain("10:43:28");
      expect(html).not.toContain("&amp;#x2F;");
      expect(html).not.toContain("private-instance");
      expect(html).toContain(
        lang === "ja" ? "スタックトレースが記録されていません" : "No stack trace was recorded",
      );
      preview(lang, lang, html);
    }
  });

  it("preserves the error tab and level when changing period, and provides a usage link", async () => {
    const html = renderToStaticMarkup(
      await DesktopErrorsView({
        lang: "en",
        range: "7d",
        level: "fatal",
        result: { status: "ready", report },
      }),
    );
    expect(html).toContain('href="/en/admin/usage?range=1h&amp;tab=errors&amp;level=fatal"');
    expect(html).toContain('href="/en/admin/usage?range=7d"');
    expect(html).toContain('href="/en/admin/usage?tab=errors&amp;range=7d&amp;level=critical"');
  });

  it("makes partial coverage explicit without treating failures as an empty report", async () => {
    const partial = await render("en", { status: "ready", report: { ...report, truncated: true } });
    expect(partial).toContain("Showing the newest 200 records");
    expect(partial).toContain("Fetched log coverage:");
    expect(partial).toContain("10:39:28");
    expect(partial).toContain("10:43:28");
    preview("truncated", "en", partial);
    const empty = await render("en", {
      status: "ready",
      report: buildDesktopErrorReport(logResponse(), window),
    });
    expect(empty).toContain("No error logs match");
    expect(empty).not.toContain("Fetched log coverage:");
    preview("empty", "en", empty);
    for (const status of ["notConfigured", "unavailable"] as const) {
      const html = await render("en", { status });
      expect(html).toContain(status === "notConfigured" ? "not configured" : "could not be loaded");
      expect(html).not.toContain("No error logs match");
      expect(html).toContain("Usage</a>");
      preview(status, "en", html);
    }
  });

  it("escapes upstream log text instead of rendering it as HTML", async () => {
    const html = await render("en", {
      status: "ready",
      report: buildDesktopErrorReport(
        logResponse([
          logEntry(1, {
            exception_message: '<script>alert("log")</script>',
            exception_stacktrace: '<img src=x onerror="alert(1)">',
          }),
        ]),
        window,
      ),
    });
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
  });
});
