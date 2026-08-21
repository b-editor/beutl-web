import { describe, expect, it } from "vitest";
import {
  blockedReason,
  blocksSubmit,
  canSubmitAiRequest,
  keepsIdempotencyKey,
  type AiAccess,
} from "../../apps/web/src/lib/ai-screen";

const NOTHING_BLOCKS = {
  submitBlocked: false,
  hasTask: true,
  taskUnaffordable: false,
  taskHasNoModel: false,
  busy: false,
};

function accessWith(overrides: Partial<AiAccess> = {}): AiAccess {
  return {
    canUseAi: true,
    availability: { "image.edit.upscale": true },
    models: { "image.edit.upscale": [] },
    ...overrides,
  };
}

describe("what an AI screen will send", () => {
  it("sends when nothing is in the way", () => {
    expect(canSubmitAiRequest(NOTHING_BLOCKS)).toBe(true);
  });

  it.each([
    ["the screen is blocked", { submitBlocked: true }],
    ["no task is chosen", { hasTask: false }],
    ["this task alone is unaffordable", { taskUnaffordable: true }],
    ["this task has no model that can serve it", { taskHasNoModel: true }],
    ["a run is already going", { busy: true }],
  ])("refuses while %s", (_reason, overrides) => {
    // ボタンとキーボード送信は同じ答えを使う。ここで通してしまうものは、入力欄で
    // Enter を押しただけで課金される。
    expect(canSubmitAiRequest({ ...NOTHING_BLOCKS, ...overrides })).toBe(false);
  });

  it("keeps the way back to a paid job open past every reason to say no", () => {
    // サーバーは、その名前が指す job を契約・残高・モデルの提供状況より先に返す。
    // 画面がここで塞ぐと、支払い済みの結果に手が届かなくなる。
    for (const code of [
      "aiRequestInterrupted",
      "aiRequestInProgress",
      "aiResultUnavailable",
    ]) {
      expect(keepsIdempotencyKey(code)).toBe(true);
      expect(blocksSubmit("plan", keepsIdempotencyKey(code))).toBe(false);
      expect(blocksSubmit("balance", keepsIdempotencyKey(code))).toBe(false);
      expect(blocksSubmit("unavailable", keepsIdempotencyKey(code))).toBe(false);
    }
  });

  it("treats a settled failure as a settled failure", () => {
    expect(keepsIdempotencyKey("aiProviderError")).toBe(false);
    expect(blocksSubmit("balance", false)).toBe(true);
    expect(blocksSubmit(null, false)).toBe(false);
  });

  it("says a screen with no usable model is unavailable, not unaffordable", () => {
    // 残高が足りていても、動かせるモデルが無ければ送信は必ず拒否される。購入を
    // 勧めても何も始まらない。
    expect(blockedReason(accessWith(), ["image.edit.upscale"], true))
      .toBe("unavailable");
    expect(blockedReason(accessWith(), ["image.edit.upscale"], false))
      .toBeNull();
    expect(
      blockedReason(
        accessWith({ availability: { "image.edit.upscale": false } }),
        ["image.edit.upscale"],
        false,
      ),
    ).toBe("balance");
    expect(blockedReason(accessWith({ canUseAi: false }), [], true))
      .toBe("plan");
  });
});
