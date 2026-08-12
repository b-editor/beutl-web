import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setDbProvider,
  upsertAiSetting,
  deleteAiSetting,
  listAiSettings,
} from "@beutl/db";
import {
  AI_OPERATIONS,
  AI_SETTINGS,
  MAX_MODEL_ID_LENGTH,
  MAX_PRICE_UNITS,
  MIN_PRICE_UNITS,
  aiModelSettingKey,
  aiPriceSettingKey,
  isAiSettingKey,
  validateAiSettingValue,
} from "@beutl/core";
import {
  loadAiSettings,
  loadAiSettingsWithoutDatabase,
} from "@beutl/api";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

describe("AI settings registry", () => {
  it("defines a model and a price setting for every billable operation", () => {
    for (const operation of AI_OPERATIONS) {
      expect(AI_SETTINGS[aiModelSettingKey(operation)]).toBeDefined();
      expect(AI_SETTINGS[aiPriceSettingKey(operation)]).toBeDefined();
    }
    // モデルと単価で 2 件ずつ。取り違えると課金かモデル解決のどちらかが欠ける。
    expect(Object.keys(AI_SETTINGS)).toHaveLength(AI_OPERATIONS.length * 2);
  });

  it("never exposes secrets as configurable settings", () => {
    // API キーを DB 経由で書き換えられるようにしてはいけない。
    for (const definition of Object.values(AI_SETTINGS)) {
      expect(definition.envVar ?? "").not.toMatch(/API_KEY|SECRET|TOKEN/i);
    }
  });

  it("rejects unknown keys", () => {
    expect(isAiSettingKey("model.image.generate")).toBe(true);
    expect(isAiSettingKey("model.unknown.operation")).toBe(false);
    expect(isAiSettingKey(undefined)).toBe(false);
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
    // 0 は「無料」になり実質無制限利用を許してしまう。
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

  it("prefers the environment variable over the built-in default", async () => {
    vi.stubEnv("OPENROUTER_IMAGE_MODEL", "openai/gpt-image-2");
    const settings = await loadAiSettings();
    expect(settings.getModel("image.generate")).toBe("openai/gpt-image-2");
    const entry = settings
      .all()
      .find((s) => s.key === "model.image.generate");
    expect(entry?.source).toBe("environment");
  });

  it("prefers the stored setting over the environment variable", async () => {
    vi.stubEnv("OPENROUTER_IMAGE_MODEL", "openai/from-env");
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
    // レジストリの値域を後から狭めた場合に、不正な値をプロバイダや課金へ流さない。
    await upsertAiSetting({
      key: "price.image.generate",
      value: "999999",
      updatedBy: "admin-1",
    });
    vi.stubEnv("OPENROUTER_IMAGE_MODEL", "not a model id");

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

  it("resolves without touching the database when asked", () => {
    vi.stubEnv("OPENROUTER_STT_MODEL", "openai/whisper-from-env");
    const settings = loadAiSettingsWithoutDatabase();
    expect(settings.getModel("audio.transcribe")).toBe(
      "openai/whisper-from-env",
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
