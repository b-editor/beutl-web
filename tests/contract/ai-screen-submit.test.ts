import { describe, expect, it } from "vitest";
import {
  aiRequestNameOf,
  blockedReason,
  blocksSubmit,
  canSubmitAiRequest,
  commitAiRequestName,
  holdsAiRequestName,
  keepsIdempotencyKey,
  newAiRequestNames,
  settleAiRequestName,
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

describe("which names a screen holds", () => {
  function mint() {
    let issued = 0;
    return () => `name-${++issued}`;
  }

  it("keeps a name for every request still waiting", () => {
    // A を回収している途中で中身を変えた B を送ると、名前は 2 つ同時に未決着に
    // なり得る。B の応答で A の名前まで捨てると、支払い済みの A に戻れない。
    const next = mint();
    let names = newAiRequestNames(next);

    const a = aiRequestNameOf(names, "request-a");
    names = commitAiRequestName(names, "request-a", next);
    const b = aiRequestNameOf(names, "request-b");
    names = commitAiRequestName(names, "request-b", next);

    expect(b).not.toBe(a);
    expect(aiRequestNameOf(names, "request-a")).toBe(a);
    expect(holdsAiRequestName(names, "request-a")).toBe(true);
    expect(holdsAiRequestName(names, "request-b")).toBe(true);

    // B が決着した。A の名前はそのまま。
    names = settleAiRequestName(names, false);

    expect(holdsAiRequestName(names, "request-b")).toBe(false);
    expect(aiRequestNameOf(names, "request-a")).toBe(a);
  });

  it("mints a name only when one is sent", () => {
    // 書き換えるたびに作っていては、打鍵のたびに使われない名前が積み上がる。
    const next = mint();
    const names = newAiRequestNames(next);

    expect(aiRequestNameOf(names, "half-typed"))
      .toBe(aiRequestNameOf(names, "half-typed-more"));
    expect(holdsAiRequestName(names, "half-typed")).toBe(false);
  });

  it("keeps the name of a request that is still running", () => {
    const next = mint();
    let names = newAiRequestNames(next);
    const sent = aiRequestNameOf(names, "request");
    names = commitAiRequestName(names, "request", next);

    names = settleAiRequestName(names, true);

    expect(aiRequestNameOf(names, "request")).toBe(sent);
    expect(holdsAiRequestName(names, "request")).toBe(true);
  });

  it("sends the same request under the name it already has", () => {
    // 中身を戻したなら、それは同じ依頼。新しい名前を作ると、支払い済みのものを
    // もう一度買うことになる。
    const next = mint();
    let names = newAiRequestNames(next);
    const first = aiRequestNameOf(names, "request");
    names = commitAiRequestName(names, "request", next);
    names = commitAiRequestName(names, "other", next);

    expect(aiRequestNameOf(names, "request")).toBe(first);
    names = commitAiRequestName(names, "request", next);
    expect(aiRequestNameOf(names, "request")).toBe(first);
  });
});
