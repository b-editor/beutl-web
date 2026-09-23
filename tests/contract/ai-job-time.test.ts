import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDateTime } from "@beutl/core";
import { browserTimeZone } from "../../apps/web/src/lib/client-time-zone";

describe("AI job history time", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses the viewer's local zone for a UTC job timestamp", () => {
    const resolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockImplementation(function () {
        return { ...resolvedOptions.call(this), timeZone: "Asia/Tokyo" };
      });

    const createdAt = "2026-09-23T07:58:28.759Z";
    expect(formatDateTime(createdAt, "ja", browserTimeZone()))
      .toBe("2026年9月23日 16:58");
  });

  it("falls back to UTC if the browser omits its time zone", () => {
    const resolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockImplementation(function () {
        return { ...resolvedOptions.call(this), timeZone: "" };
      });

    expect(browserTimeZone()).toBe("UTC");
  });
});
