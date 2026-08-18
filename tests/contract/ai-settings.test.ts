import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setDbProvider,
  upsertAiSetting,
  deleteAiSetting,
  listAiSettings,
} from "@beutl/db";
import {
  AI_PLAN_MONTHLY_USAGE_LIMIT_KEY,
  AI_SETTINGS,
  DEFAULT_MONTHLY_USAGE_LIMIT,
  MAX_MONTHLY_USAGE_LIMIT,
  MIN_MONTHLY_USAGE_LIMIT,
  isAiSettingKey,
  validateAiSettingValue,
} from "@beutl/core";
import { loadAiSettings } from "@beutl/api";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

describe("AI settings registry", () => {
  it("holds the allowance and nothing per-operation", () => {
    // Models and their prices are rows in AiOperationModel. They were briefly
    // here as well, which put two controls on the admin page for one value and
    // left the one that no longer applied silently doing nothing.
    expect(Object.keys(AI_SETTINGS)).toEqual([AI_PLAN_MONTHLY_USAGE_LIMIT_KEY]);
    expect(AI_SETTINGS[AI_PLAN_MONTHLY_USAGE_LIMIT_KEY]).toMatchObject({
      kind: "limit",
      fallback: String(DEFAULT_MONTHLY_USAGE_LIMIT),
    });
  });

  it.each([
    [String(MIN_MONTHLY_USAGE_LIMIT), true],
    [String(MAX_MONTHLY_USAGE_LIMIT), true],
    ["500", true],
    // Zero would silently disable the plan for every subscriber.
    ["0", false],
    ["-1", false],
    ["1.5", false],
    [String(MAX_MONTHLY_USAGE_LIMIT + 1), false],
    ["1e3", false],
    ["abc", false],
    ["", false],
  ])("validates the monthly allowance %s as %s", (value, expected) => {
    const result = validateAiSettingValue(
      AI_PLAN_MONTHLY_USAGE_LIMIT_KEY,
      value,
    );
    expect(result.ok).toBe(expected);
    if (!result.ok) {
      expect(result.error).toMatch(/^(invalidLimit|limitOutOfRange)$/);
    }
  });

  it("trims surrounding whitespace before persisting", () => {
    expect(validateAiSettingValue(AI_PLAN_MONTHLY_USAGE_LIMIT_KEY, " 900 "))
      .toEqual({ ok: true, value: "900" });
  });

  it("rejects unknown keys", () => {
    expect(isAiSettingKey(AI_PLAN_MONTHLY_USAGE_LIMIT_KEY)).toBe(true);
    // These were settings until models moved to their own table; a stored row
    // for one is stale data, not a key this registry answers for.
    expect(isAiSettingKey("model.image.generate")).toBe(false);
    expect(isAiSettingKey("price.image.generate")).toBe(false);
    expect(isAiSettingKey(undefined)).toBe(false);
    expect(isAiSettingKey("toString")).toBe(false);
    expect(isAiSettingKey("constructor")).toBe(false);
    expect(isAiSettingKey("__proto__")).toBe(false);
    expect(validateAiSettingValue("nope", "x")).toEqual({
      ok: false,
      error: "unknownKey",
    });
  });
});

describe("AI settings resolution", () => {
  beforeEach(() => {
    const memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves the monthly allowance from the database", async () => {
    expect((await loadAiSettings()).getMonthlyUsageLimit()).toBe(
      DEFAULT_MONTHLY_USAGE_LIMIT,
    );

    await upsertAiSetting({
      key: AI_PLAN_MONTHLY_USAGE_LIMIT_KEY,
      value: "1200",
      updatedBy: "admin-1",
    });
    expect((await loadAiSettings()).getMonthlyUsageLimit()).toBe(1200);

    await deleteAiSetting({ key: AI_PLAN_MONTHLY_USAGE_LIMIT_KEY });
    expect((await loadAiSettings()).getMonthlyUsageLimit()).toBe(
      DEFAULT_MONTHLY_USAGE_LIMIT,
    );
    expect(await listAiSettings()).toHaveLength(0);
  });

  it("ignores a stored allowance that no longer passes validation", async () => {
    // A future registry restriction must not pass stale invalid values onward.
    await upsertAiSetting({
      key: AI_PLAN_MONTHLY_USAGE_LIMIT_KEY,
      value: "0",
      updatedBy: "admin-1",
    });

    expect((await loadAiSettings()).getMonthlyUsageLimit()).toBe(
      DEFAULT_MONTHLY_USAGE_LIMIT,
    );
  });

  it("ignores a row left behind by a setting that no longer exists", async () => {
    await upsertAiSetting({
      key: "model.image.generate",
      value: "openai/from-database",
      updatedBy: "admin-1",
    });

    // The seeding migration leaves these rows in place so a rolled-back deploy
    // finds its prices again; nothing running reads them.
    const settings = await loadAiSettings();
    expect(settings.all().map((entry) => entry.key)).toEqual([
      AI_PLAN_MONTHLY_USAGE_LIMIT_KEY,
    ]);
  });
});
