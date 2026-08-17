import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setDbProvider,
  upsertAiSetting,
  deleteAiSetting,
  listAiSettings,
} from "@beutl/db";
import {
  AI_OPERATIONS,
  AI_PLAN_MONTHLY_USAGE_LIMIT_KEY,
  AI_SETTINGS,
  DEFAULT_MONTHLY_USAGE_LIMIT,
  MAX_MODEL_ID_LENGTH,
  MAX_MONTHLY_USAGE_LIMIT,
  MAX_PRICE_UNITS,
  MIN_MONTHLY_USAGE_LIMIT,
  MIN_PRICE_UNITS,
  aiModelSettingKey,
  aiPriceSettingKey,
  isAiSettingKey,
  validateAiSettingValue,
} from "@beutl/core";
import { loadAiSettings } from "@beutl/api";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

describe("AI settings registry", () => {
  it("defines a model and a price setting for every billable operation", () => {
    for (const operation of AI_OPERATIONS) {
      expect(AI_SETTINGS[aiModelSettingKey(operation)]).toBeDefined();
      expect(AI_SETTINGS[aiPriceSettingKey(operation)]).toBeDefined();
    }
    // Each operation has a model and price; a mismatch would omit one category.
    // The plan-wide monthly allowance is the one setting without an operation.
    expect(Object.keys(AI_SETTINGS)).toHaveLength(AI_OPERATIONS.length * 2 + 1);
    expect(AI_SETTINGS[AI_PLAN_MONTHLY_USAGE_LIMIT_KEY]).toMatchObject({
      kind: "limit",
      fallback: String(DEFAULT_MONTHLY_USAGE_LIMIT),
    });
    expect(AI_SETTINGS[AI_PLAN_MONTHLY_USAGE_LIMIT_KEY]?.operation).toBeUndefined();
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

  it("rejects unknown keys", () => {
    expect(isAiSettingKey("model.image.generate")).toBe(true);
    expect(isAiSettingKey("model.unknown.operation")).toBe(false);
    expect(isAiSettingKey(undefined)).toBe(false);
    expect(isAiSettingKey("toString")).toBe(false);
    expect(isAiSettingKey("constructor")).toBe(false);
    expect(isAiSettingKey("__proto__")).toBe(false);
    expect(validateAiSettingValue("nope", "x")).toEqual({
      ok: false,
      error: "unknownKey",
    });
  });

  it.each([
    ["openai/gpt-image-1", true],
    ["bytedance-seed/seedream-4.5", true],
    ["anthropic/claude-haiku-4.5", true],
    ["openai/whisper-large-v3-turbo", true],
    ["provider/model:free", true],
    ["no-slash", false],
    ["/leading-slash", false],
    ["trailing/", false],
    ["has space/model", false],
    ["", false],
  ])("validates the model id %s as %s", (value, expected) => {
    const result = validateAiSettingValue("model.image.generate", value);
    expect(result.ok).toBe(expected);
  });

  it("rejects a model id longer than the column budget", () => {
    const tooLong = `openai/${"a".repeat(MAX_MODEL_ID_LENGTH)}`;
    expect(validateAiSettingValue("model.image.generate", tooLong)).toEqual({
      ok: false,
      error: "modelIdTooLong",
    });
  });

  it("trims surrounding whitespace before persisting a model id", () => {
    expect(
      validateAiSettingValue("model.image.generate", "  openai/gpt-image-1  "),
    ).toEqual({ ok: true, value: "openai/gpt-image-1" });
  });

  it.each([
    [String(MIN_PRICE_UNITS), true],
    [String(MAX_PRICE_UNITS), true],
    ["20", true],
    // Zero would make the operation free and effectively unlimited.
    ["0", false],
    ["-1", false],
    ["1.5", false],
    [String(MAX_PRICE_UNITS + 1), false],
    ["1e3", false],
    ["abc", false],
    ["", false],
  ])("validates the price %s as %s", (value, expected) => {
    const result = validateAiSettingValue("price.image.generate", value);
    expect(result.ok).toBe(expected);
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

  it("falls back to the built-in default when nothing is configured", async () => {
    const settings = await loadAiSettings();
    expect(settings.getModel("image.generate")).toBe("openai/gpt-image-1");
    expect(settings.getPrice("image.generate")).toBe(20);
    expect(settings.getModel("video.generate")).toBe("google/veo-3.1");
    expect(settings.getPrice("video.generate")).toBe(40);
  });

  it("ignores environment overrides for model resolution", async () => {
    vi.stubEnv("OPENROUTER_IMAGE_MODEL", "openai/gpt-image-2");
    const settings = await loadAiSettings();
    expect(settings.getModel("image.generate")).toBe("openai/gpt-image-1");
    const entry = settings
      .all()
      .find((s) => s.key === "model.image.generate");
    expect(entry?.source).toBe("default");
  });

  it("prefers the stored setting over the built-in default", async () => {
    await upsertAiSetting({
      key: "model.image.generate",
      value: "openai/from-database",
      updatedBy: "admin-1",
    });

    const settings = await loadAiSettings();
    expect(settings.getModel("image.generate")).toBe("openai/from-database");
    const entry = settings
      .all()
      .find((s) => s.key === "model.image.generate");
    expect(entry?.source).toBe("database");
  });

  it("ignores a stored value that no longer passes validation", async () => {
    // A future registry restriction must not pass stale invalid values onward.
    await upsertAiSetting({
      key: "price.image.generate",
      value: String(MAX_PRICE_UNITS + 1),
      updatedBy: "admin-1",
    });

    const settings = await loadAiSettings();
    expect(settings.getPrice("image.generate")).toBe(20);
    expect(settings.getModel("image.generate")).toBe("openai/gpt-image-1");
  });

  it("resets to the fallback chain when the stored row is deleted", async () => {
    await upsertAiSetting({
      key: "price.video.generate",
      value: "80",
      updatedBy: "admin-1",
    });
    expect((await loadAiSettings()).getPrice("video.generate")).toBe(80);

    await deleteAiSetting({ key: "price.video.generate" });
    expect((await loadAiSettings()).getPrice("video.generate")).toBe(40);
    expect(await listAiSettings()).toHaveLength(0);
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
  });

  it("ignores a stored allowance that no longer passes validation", async () => {
    await upsertAiSetting({
      key: AI_PLAN_MONTHLY_USAGE_LIMIT_KEY,
      value: "0",
      updatedBy: "admin-1",
    });

    expect((await loadAiSettings()).getMonthlyUsageLimit()).toBe(
      DEFAULT_MONTHLY_USAGE_LIMIT,
    );
  });

  it("exposes every operation through the snapshot", async () => {
    const settings = await loadAiSettings();
    for (const operation of AI_OPERATIONS) {
      expect(settings.getModel(operation)).toMatch(/^[^/]+\/.+$/);
      expect(settings.getPrice(operation)).toBeGreaterThanOrEqual(
        MIN_PRICE_UNITS,
      );
    }
  });
});
