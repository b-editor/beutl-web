import { describe, expect, it } from "vitest";
import {
  summarizeAiUsageDistribution,
  type AiUsageDistributionRow,
} from "../../apps/admin/src/lib/ai-usage-distribution";

const NOW = new Date("2026-08-17T00:00:00.000Z");
const PERIOD_START = new Date("2026-08-01T00:00:00.000Z");
const PERIOD_END = new Date("2026-09-01T00:00:00.000Z");
const LIMIT = 500;

function account(
  monthlyUsageUsed: number,
  overrides: Partial<AiUsageDistributionRow> = {},
): AiUsageDistributionRow {
  return {
    monthlyUsageUsed,
    purchasedCredits: 0,
    usagePeriodStart: PERIOD_START,
    usagePeriodEnd: PERIOD_END,
    ...overrides,
  };
}

function summarize(rows: AiUsageDistributionRow[], scanLimit = 100) {
  return summarizeAiUsageDistribution({
    rows,
    monthlyUsageLimit: LIMIT,
    now: NOW,
    scanLimit,
  });
}

describe("AI usage distribution", () => {
  it("reports nothing rather than NaN when there are no accounts", () => {
    const result = summarize([]);
    expect(result.quantiles).toBeNull();
    expect(result.projected).toBeNull();
    expect(result.measuredCount).toBe(0);
    expect(result.histogram.every((entry) => entry.count === 0)).toBe(true);
  });

  it.each([
    [1, [10], 10],
    [2, [10, 20], 10],
    [3, [10, 20, 30], 20],
    [4, [10, 20, 30, 40], 20],
    [10, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5],
  ])(
    "places the median by nearest rank for %i accounts",
    (_size, values, expected) => {
      expect(summarize(values.map((value) => account(value))).quantiles?.p50).toBe(
        expected,
      );
    },
  );

  it("returns values that accounts actually recorded", () => {
    const result = summarize([10, 20, 30, 40, 50].map((v) => account(v)));
    expect(result.quantiles).toEqual({ p50: 30, p75: 40, p90: 50, p95: 50 });
  });

  it("excludes rows whose period already ended and says how many", () => {
    // The counter is only reset when the account next runs a job, so a row past
    // its period end still holds the previous period's total.
    const result = summarize([
      account(100),
      account(500, { usagePeriodEnd: new Date("2026-08-01T00:00:00.000Z") }),
      account(480, { usagePeriodEnd: new Date("2026-07-01T00:00:00.000Z") }),
    ]);

    expect(result.totalRows).toBe(3);
    expect(result.staleCount).toBe(2);
    expect(result.measuredCount).toBe(1);
    // Counting the stale rows would have reported a 66% exhaustion rate.
    expect(result.exhaustedCount).toBe(0);
    expect(result.quantiles?.p50).toBe(100);
  });

  it("counts an account as exhausted after the allowance is lowered below it", () => {
    const result = summarizeAiUsageDistribution({
      rows: [account(600)],
      monthlyUsageLimit: 500,
      now: NOW,
      scanLimit: 100,
    });
    expect(result.exhaustedCount).toBe(1);
    expect(
      result.histogram.find((entry) => entry.bucket === "exhausted")?.count,
    ).toBe(1);
  });

  it("buckets consumption by share of the allowance", () => {
    const result = summarize([
      account(0),
      account(100),
      account(250),
      account(375),
      account(499),
      account(500),
    ]);

    expect(result.histogram).toEqual([
      { bucket: "zero", count: 1 },
      { bucket: "upTo25", count: 1 },
      { bucket: "upTo50", count: 1 },
      { bucket: "upTo75", count: 1 },
      { bucket: "upTo99", count: 1 },
      { bucket: "exhausted", count: 1 },
    ]);
    expect(result.zeroCount).toBe(1);
  });

  it("projects from elapsed time but ignores accounts barely into a period", () => {
    const justStarted = {
      usagePeriodStart: new Date("2026-08-16T12:00:00.000Z"),
      usagePeriodEnd: new Date("2026-09-16T12:00:00.000Z"),
    };
    const result = summarize([
      // Half the period elapsed with 100 used projects to 200.
      account(100, {
        usagePeriodStart: new Date("2026-08-01T00:00:00.000Z"),
        usagePeriodEnd: new Date("2026-09-02T00:00:00.000Z"),
      }),
      // 1.6% elapsed: one job would extrapolate to an absurd total.
      account(40, justStarted),
    ]);

    expect(result.projected?.sampleSize).toBe(1);
    expect(result.projected?.p50).toBe(200);
    // The excluded row is still measured for the plain quantiles.
    expect(result.measuredCount).toBe(2);
  });

  it("counts accounts holding purchased credits", () => {
    const result = summarize([
      account(500, { purchasedCredits: 120 }),
      account(200),
    ]);
    expect(result.purchasedCreditHolders).toBe(1);
  });

  it("flags a truncated scan and summarizes only what it scanned", () => {
    const rows = Array.from({ length: 6 }, (_unused, index) =>
      account(index * 10),
    );
    const result = summarize(rows, 5);

    expect(result.truncated).toBe(true);
    expect(result.totalRows).toBe(5);
  });
});
