import { describe, expect, it } from "vitest";
import {
  aiScreenUploadLimit,
  MAX_AI_IMAGE_UPLOAD_BYTES,
  MAX_AI_TRANSCRIPTION_UPLOAD_BYTES,
  MAX_AI_VIDEO_FRAME_UPLOAD_BYTES,
} from "@beutl/core";
import {
  aiRequestNameOf,
  blockedReason,
  blocksSubmit,
  canSubmitAiRequest,
  commitAiRequestName,
  holdsAiRequestName,
  keepsIdempotencyKey,
  newAiRequestNames,
  fileFingerprint,
  keepModelForHeldRequest,
  readyAiRequestNames,
  requestSignature,
  seedValue,
  settleAiRequestName,
  type AiAccess,
  type AiScreenModel,
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

describe("how a request is signed", () => {
  it("tells apart runs a separator alone would merge", () => {
    // 区切りだけで繋ぐと、区切り文字を含む値や境目のずれた並びが同じ 1 本に
    // なる。別の依頼が同じ名前で送られ、断られるまで気づけない。
    expect(requestSignature(["a", "b"])).not.toBe(requestSignature(["a\u001fb"]));
    expect(requestSignature(["ab", "c"])).not.toBe(requestSignature(["a", "bc"]));
    expect(requestSignature(["", "a"])).not.toBe(requestSignature(["a", ""]));
  });

  it("tells a missing part from an empty one", () => {
    expect(requestSignature([null])).not.toBe(requestSignature([""]));
    expect(requestSignature([undefined])).toBe(requestSignature([null]));
  });

  it("reads the same file the same way however often it is made", () => {
    // 動画から音声を抜き出すたびに新しい更新時刻がつく。そこを見ていると、同じ
    // 音声が別の依頼になり、二度課金される。
    const made = (lastModified: number) =>
      new File(["same bytes"], "clip.wav", { type: "audio/wav", lastModified });

    expect(requestSignature([made(1)])).toBe(requestSignature([made(2)]));
    // ブラウザが名乗る種類も見ない。サーバーは中身から見直すので、image/jpg と
    // image/jpeg は同じものになる。
    expect(
      requestSignature([
        new File(["same"], "a.jpg", { type: "image/jpg" }),
      ]),
    ).toBe(
      requestSignature([
        new File(["same"], "a.jpg", { type: "image/jpeg" }),
      ]),
    );
    expect(requestSignature([made(1)])).not.toBe(
      requestSignature([
        new File(["same bytes"], "other.wav", { type: "audio/wav" }),
      ]),
    );
  });
});

describe("what a screen reads before it names a request", () => {
  it("counts a seed the way the server reads it", () => {
    // サーバーは Number() で読む。欄に書かれたままを数えると、"1"、"01"、"1.0"
    // が三つの名前になり、同じ依頼が三度課金される。
    expect(seedValue("1")).toBe(seedValue("01"));
    expect(seedValue("1")).toBe(seedValue("1.0"));
    expect(requestSignature([seedValue("1")])).toBe(
      requestSignature([seedValue(" 1 ")]),
    );
    // 種のない依頼と、種の欄が空の依頼は同じもの——サーバーはどちらでも seed を
    // 載せない。
    expect(seedValue("")).toBeNull();
    expect(seedValue("   ")).toBeNull();
    // 数として読めないものは名前にしない。サーバーはそれを断るので、粗いほうへ
    // 外れても失うものはない。
    expect(seedValue("abc")).toBeNull();
  });

  it("does not read a file the request is not allowed to send", async () => {
    // 送っても断られるものを丸ごとメモリに載せると、その前にタブのほうが落ちる。
    const file = new File(["0123456789"], "big.png", { type: "image/png" });

    expect(await fileFingerprint(file, 4)).toBe("");
    expect(await fileFingerprint(file, 10)).not.toBe("");
  });

  it("tells apart files a name and a size alone would merge", async () => {
    // 中身の違う同名同サイズの絵。中身を見ないと同じ依頼に見え、片方が走って
    // いる間もう片方を始められない。
    const one = new File(["aaaa"], "same.png", { type: "image/png" });
    const other = new File(["bbbb"], "same.png", { type: "image/png" });

    expect(requestSignature([one])).toBe(requestSignature([other]));
    expect(await fileFingerprint(one, 1024)).not.toBe(
      await fileFingerprint(other, 1024),
    );
  });
});

describe("which model a screen names", () => {
  const offered = [
    { id: "model-x", displayName: "Model X", costTier: null, available: true },
  ] as const;

  it("keeps a model the catalog dropped while its request is uncollected", () => {
    // 一覧は運営の都合で入れ替わる。選んでいたモデルが消えたときに既定へ落とすと
    // 依頼の形が変わり、サーバーは同じ名前の別の依頼として断る——支払い済みの
    // 結果へ戻る道がそこで閉じる。
    const kept = keepModelForHeldRequest(offered, "model-gone");

    expect(kept.map((model) => model.id)).toEqual(["model-x", "model-gone"]);
    // 新しく選べるようにはしない。止められたモデルで始めても断られるだけ。
    expect(kept.at(-1)?.available).toBe(false);
  });

  it("leaves the list alone when the model is still on it", () => {
    expect(keepModelForHeldRequest(offered, "model-x")).toEqual([...offered]);
    expect(keepModelForHeldRequest(offered, "")).toEqual([...offered]);
  });
});

describe("how a video frame is signed", () => {
  it("reads the same frame the same way whatever the file is called", async () => {
    // サーバーはフレームを中身と種類だけで見分ける。名前を数えると、場面から
    // 切り出し直した同じ一枚が別の依頼になり、支払い済みのものへ戻れないまま
    // 二度課金される。
    const one = new File(["same frame"], "frame-a1b2.png", { type: "image/png" });
    const other = new File(["same frame"], "frame-c3d4.png", { type: "image/png" });

    const signatureOf = async (frame: File) =>
      requestSignature([
        "a prompt",
        frame !== null,
        await fileFingerprint(frame, 1024),
      ]);

    expect(await signatureOf(one)).toBe(await signatureOf(other));
    expect(await signatureOf(one)).not.toBe(
      await signatureOf(new File(["other frame"], "frame-a1b2.png", { type: "image/png" })),
    );
  });
});

describe("what an AI screen may put in one body", () => {
  it("caps each screen at what its own files come to", () => {
    // Server Action の本文上限はアプリ全体で 1 つで、パッケージのアップロードに
    // 合わせた大きさ。そのままでは、有効な 1 枚と無関係な詰め物を並べるだけで、
    // 断られるより先に本文まるごとを組み立てさせられる。
    const edit = aiScreenUploadLimit("/ja/dashboard/ai/edit");
    const transcribe = aiScreenUploadLimit("/dashboard/ai/transcribe");
    const video = aiScreenUploadLimit("/en/dashboard/ai/video/");

    expect(edit).toBeGreaterThan(MAX_AI_IMAGE_UPLOAD_BYTES);
    expect(edit).toBeLessThan(2 * MAX_AI_IMAGE_UPLOAD_BYTES);
    expect(transcribe).toBeGreaterThan(MAX_AI_TRANSCRIPTION_UPLOAD_BYTES);
    // 始まりと終わりで 2 枚ぶん。1 枚しか見ないと、2 枚の依頼が届かない。
    expect(video).toBeGreaterThan(2 * MAX_AI_VIDEO_FRAME_UPLOAD_BYTES);
    expect(video).toBeLessThan(3 * MAX_AI_VIDEO_FRAME_UPLOAD_BYTES);
  });

  it("leaves screens it does not name alone", () => {
    // 名前のない画面まで縛ると、パッケージのアップロードが送れなくなる。
    expect(aiScreenUploadLimit("/ja/dashboard/packages/upload")).toBeNull();
    expect(aiScreenUploadLimit("/ja/dashboard/ai")).toBeNull();
    expect(aiScreenUploadLimit("/ja/dashboard/ai/jobs/abc")).toBeNull();
  });

  it("gives every screen room for the fields beside the file", () => {
    // 動画の画面は文章の欄を 5 つ持ち、どれも上限まで書ける。境界のぶんしか
    // 見ないと、上限まで書いた依頼が届く前に断られる。
    for (const screen of ["edit", "generate", "transcribe", "video", "translate"]) {
      const limit = aiScreenUploadLimit(`/ja/dashboard/ai/${screen}`);
      expect(limit).not.toBeNull();
      expect(limit).toBeGreaterThan(6 * 4_000 * 4);
    }
  });
});

describe("which request a screen is looking at", () => {
  it("still holds the name of a request the last answer was not about", () => {
    // A が回収待ちのまま B を送って決着させ、A へ戻る。直前の応答だけを見ると
    // 「決着済み」に見えて残高で塞がれ、支払い済みの A を取りに行けない。
    let names = readyAiRequestNames(newAiRequestNames(), () => "key-a");
    names = commitAiRequestName(names, "request-a", () => "key-b");
    // A は不明のまま終わったので、その名前は残る。
    names = settleAiRequestName(names, true);
    names = commitAiRequestName(names, "request-b", () => "key-c");
    // B は決着したので、B の名前だけ手放す。
    names = settleAiRequestName(names, false);

    expect(holdsAiRequestName(names, "request-b")).toBe(false);
    expect(holdsAiRequestName(names, "request-a")).toBe(true);
    expect(aiRequestNameOf(names, "request-a")).toBe("key-a");
    // A へ戻ったとき、残高で塞いではいけない。
    expect(blocksSubmit("balance", holdsAiRequestName(names, "request-a"))).toBe(false);
    expect(blocksSubmit("balance", holdsAiRequestName(names, "request-b"))).toBe(true);
  });

  it("keeps every model an uncollected request named, not just the last", () => {
    // 同じ task の依頼が 2 つ未回収で残ることがある。いま選んでいる 1 つだけを
    // 残すと、もう一方のモデルへ戻れず、その名前が指す支払い済みの結果に届かない。
    const offered = [
      { id: "model-x", displayName: "Model X", costTier: null, available: true },
    ] as const;
    const kept = ["model-a", "model-b"].reduce(
      keepModelForHeldRequest,
      offered as unknown as AiScreenModel[],
    );

    expect(kept.map((model) => model.id)).toEqual(["model-x", "model-a", "model-b"]);
    expect(kept.filter((model) => !model.available)).toHaveLength(2);
  });
});
