import { describe, expect, it } from "vitest";
import {
  formatCount,
  formatDate,
  formatDateTime,
  toLocaleTag,
} from "@beutl/core";

describe("locale formatting", () => {
  it("maps ja to ja-JP and every other language to en-US", () => {
    expect(toLocaleTag("ja")).toBe("ja-JP");
    expect(toLocaleTag("en")).toBe("en-US");
    expect(toLocaleTag("fr")).toBe("en-US");
  });

  // Workers run in UTC while a developer machine may not. Pinning the default
  // keeps the rendered date identical in CI and locally.
  it("formats a date in UTC regardless of the host time zone", () => {
    const justBeforeMidnightUtc = new Date("2026-08-10T23:30:00.000Z");
    expect(formatDate(justBeforeMidnightUtc, "ja")).toBe("2026年8月10日");
    expect(formatDate(justBeforeMidnightUtc, "en")).toBe("Aug 10, 2026");
  });

  it("accepts an ISO string as well as a Date", () => {
    expect(formatDate("2026-08-10T23:30:00.000Z", "en")).toBe("Aug 10, 2026");
  });

  it("shifts the calendar day when an explicit time zone is given", () => {
    expect(
      formatDate("2026-08-10T23:30:00.000Z", "ja", "Asia/Tokyo"),
    ).toBe("2026年8月11日");
  });

  it("includes the time of day in formatDateTime", () => {
    const formatted = formatDateTime("2026-08-10T23:30:00.000Z", "en");
    expect(formatted).toContain("Aug 10, 2026");
    expect(formatted).toContain("11:30");
  });

  it("groups counts by locale", () => {
    expect(formatCount(1234567, "ja")).toBe("1,234,567");
    expect(formatCount(1234567, "en")).toBe("1,234,567");
    expect(formatCount(0, "ja")).toBe("0");
  });
});
