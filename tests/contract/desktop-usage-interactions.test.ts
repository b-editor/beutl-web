// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "../../apps/admin/node_modules/react";
import {
  createRoot,
  type Root,
} from "../../apps/admin/node_modules/react-dom/client";
import { UsageActivityChart } from "../../apps/admin/src/app/[lang]/admin/usage/chart";
import { DesktopUsageView } from "../../apps/admin/src/app/[lang]/admin/usage/view";
import type { UsageReport } from "../../apps/admin/src/lib/desktop-usage";

const report: UsageReport = {
  since: new Date("2026-09-24T00:00:00Z"),
  until: new Date("2026-10-01T00:00:00Z"),
  activity: Array.from({ length: 168 }, (_, i) => ({
    timestampMs: Date.UTC(2026, 8, 24, i + 1),
    count: i + 1,
  })),
  rows: ["Timeline", "ColorScopes"].map((tool) => ({
    event: "tool.command",
    tool,
    feature: "Refresh",
    outcome: "",
    os: "linux",
    version: "2.0",
    count: 1,
    durationMs: 0,
  })),
};

describe("desktop usage interactions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("updates the selected tool and submitted value after same-route navigation", async () => {
    for (const tool of ["", "ColorScopes", "Timeline", ""]) {
      const view = await DesktopUsageView({
        lang: "en",
        range: "7d",
        requestedTool: tool,
        result: { status: "ready", report },
      });
      await act(() => root.render(view));
      const select =
        container.querySelector<HTMLSelectElement>("select[name=tool]")!;
      expect(select.value).toBe(tool);
      expect(new FormData(select.form!).get("tool")).toBe(tool);
    }
  });

  it.each([
    { name: "no points", points: [] },
    {
      name: "empty activity buckets",
      points: report.activity.map((point) => ({ ...point, count: 0 })),
    },
  ])("displays a zero maximum for $name", async ({ points }) => {
    await act(() =>
      root.render(
        createElement(UsageActivityChart, {
          points,
          lang: "en",
          label: "Usage",
        }),
      ),
    );
    expect(container.querySelector("output")!.textContent).toBe("max: 0");
    const bars = container.querySelectorAll("svg g rect:nth-of-type(2)");
    expect(bars).toHaveLength(points.length);
    for (const bar of bars) expect(bar.getAttribute("height")).toBe("0");
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  it("reuses the date formatter during hover and changes it when the locale changes", async () => {
    const DateTimeFormat = Intl.DateTimeFormat;
    const formatter = vi
      .spyOn(Intl, "DateTimeFormat")
      .mockImplementation(function (locales, options) {
        return new DateTimeFormat(locales, options);
      });
    const render = (lang: string) =>
      act(() =>
        root.render(
          createElement(UsageActivityChart, {
            points: report.activity,
            lang,
            label: "Usage",
          }),
        ),
      );
    await render("en");
    expect(container.querySelector("output")!.textContent).toBe("max: 168");
    expect(formatter).toHaveBeenCalledTimes(1);
    for (const index of [0, 1, 100]) {
      const bar = container.querySelectorAll("svg g")[index];
      await act(() => {
        bar.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      });
      expect(container.querySelector("output")!.textContent).toContain(
        `: ${index + 1}`,
      );
    }
    expect(formatter).toHaveBeenCalledTimes(1);
    await render("ja");
    expect(formatter).toHaveBeenCalledTimes(2);
    expect(formatter).toHaveBeenLastCalledWith(
      "ja",
      expect.objectContaining({ timeZone: "UTC" }),
    );
  });
});
