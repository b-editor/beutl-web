import { describe, expect, it } from "vitest";
import { refuseOversizedAiUpload } from "../../apps/web/src/lib/ai-upload-guard";
import {
  aiScreenUploadLimit,
  MAX_AI_IMAGE_UPLOAD_BYTES,
  MAX_AI_RESULT_BYTES,
  MAX_AI_TRANSCRIPTION_UPLOAD_BYTES,
  MAX_AI_VIDEO_FRAME_UPLOAD_BYTES,
} from "@beutl/core";
import {
  aiRequestNameOf,
  blockedReason,
  blocksSubmit,
  canSubmitModelRequest,
  canSubmitAiRequest,
  commitAiRequestName,
  correctedModelId,
  heldAiRequestModels,
  holdsAiRequestModel,
  holdsAiRequestName,
  keepsIdempotencyKey,
  newAiRequestNames,
  fileFingerprint,
  keepModelForHeldRequest,
  mergeHeldModelCapabilities,
  mergeHeldRequestCapabilities,
  mergeAiRecoveryEntries,
  removeAiRecoveryEntry,
  serializeAiRecoveryTombstone,
  isAiRecoveryTombstoned,
  modelsWithHeldRequests,
  readyAiRequestNames,
  requestSignature,
  seedValue,
  settleAiRequestName,
  reduceAiRequestRecovery,
  digestAiRequestSignature,
  aiRecoveryStorageScope,
  readAiRecoverySafely,
  restoreAiRecoveryEntries,
  serializeAiRecoveryEntries,
  AI_RECOVERY_TTL_MS,
  type AiAccess,
  type AiScreenModel,
} from "../../apps/web/src/lib/ai-screen";

// The hook uses the same lock/persist primitive; exercising the helper directly
// keeps this contract test independent of React's rendering environment.
import { acquireAiRecoveryEntry as acquirePersistedEntry } from "../../apps/web/src/lib/ai-recovery-storage";

function browserStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

function serialLocks() {
  let tail = Promise.resolve();
  return {
    request: async <T>(
      _name: string,
      _options: { mode: "exclusive" },
      callback: () => T | Promise<T>,
    ): Promise<T> => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try { return await callback(); } finally { release(); }
    },
  };
}

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
  it("persists only a SHA-256 identity digest, never request plaintext", async () => {
    const prompt = "secret prompt text";
    const digest = await digestAiRequestSignature(prompt);
    const serialized = serializeAiRecoveryEntries([{
      digest,
      key: "key-a",
      model: "",
      capability: null,
      updatedAt: Date.now(),
    }]);
    expect(serialized).not.toContain(prompt);
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("restores multiple entries while dropping corrupt and expired records", () => {
    const now = 10_000_000;
    const valid = { digest: "a".repeat(64), key: "key-a", model: "", capability: null, updatedAt: now };
    const expired = { ...valid, digest: "b".repeat(64), updatedAt: now - 31 * 24 * 60 * 60 * 1000 };
    const raw = JSON.stringify({ version: 1, entries: [valid, expired, { nope: true }] });
    expect(restoreAiRecoveryEntries(raw, now)).toEqual([valid]);
  });

  it("keeps the screen ready when browser recovery storage cannot be read", () => {
    const valid = {
      digest: "a".repeat(64), key: "key-a", model: "", capability: null,
      updatedAt: Date.now(),
    };
    expect(readAiRecoverySafely(() => JSON.stringify({ version: 1, entries: [valid] })))
      .toEqual([valid]);
    expect(readAiRecoverySafely(() => { throw new DOMException("blocked", "SecurityError"); }))
      .toEqual([]);
  });

  it("keeps valid image and video capability snapshots", () => {
    const now = 10_000_000;
    const image = {
      digest: "d".repeat(64), key: "image-key", model: "openai/gpt-image-1",
      capability: {
        aspectRatios: ["1:1"], backgrounds: ["auto"], seed: true,
        maxReferenceImages: 2,
      }, updatedAt: now,
    };
    const video = {
      digest: "e".repeat(64), key: "video-key", model: "google/veo-3.1",
      capability: {
        resolutions: ["720p"], durations: [4, 8], aspectRatios: ["16:9"],
        generateAudio: true, seed: false, firstFrame: true, lastFrame: false,
      }, updatedAt: now - 1,
    };
    expect(restoreAiRecoveryEntries(
      JSON.stringify({ version: 1, entries: [image, video] }), now,
    )).toEqual([image, video]);
  });

  it("nulls malformed capabilities and garbage-collects unsafe snapshots", () => {
    const now = 10_000_000;
    const entry = (digest: string, capability: unknown) => ({
      digest, key: "key", model: "openai/gpt-image-1", capability, updatedAt: now,
    });
    const malformed = entry("f".repeat(64), "image capability");
    const wrongField = entry("0".repeat(64), {
      aspectRatios: null, backgrounds: ["auto"], seed: true, maxReferenceImages: 1,
    });
    const deep = entry("1".repeat(64), {
      aspectRatios: [{ a: { b: { c: { d: { e: { f: { g: true } } } } } } }],
    });
    const raw = JSON.stringify({ version: 1, entries: [malformed, wrongField, deep] });
    const restored = restoreAiRecoveryEntries(raw, now);
    expect(restored).toEqual([
      { ...malformed, capability: null },
      { ...wrongField, capability: null },
      { ...deep, capability: null },
    ]);
  });

  it("keeps only the newest duplicate digest and rejects oversized identity fields", () => {
    const now = 10_000_000;
    const base = {
      digest: "2".repeat(64), key: "key", model: "", capability: null,
      updatedAt: now - 10,
    };
    const newest = { ...base, key: "new-key", updatedAt: now };
    const oversizedKey = {
      ...base, digest: "3".repeat(64), key: "k".repeat(256), updatedAt: now,
    };
    const oversizedModel = {
      ...base, digest: "4".repeat(64), model: "m".repeat(129), updatedAt: now,
    };
    expect(restoreAiRecoveryEntries(
      JSON.stringify({ version: 1, entries: [base, newest, oversizedKey, oversizedModel] }), now,
    )).toEqual([newest]);
  });

  it("keeps recovery through the server retention boundary but not beyond it", () => {
    const now = 10_000_000;
    const entry = { digest: "c".repeat(64), key: "key-c", model: "", capability: null,
      updatedAt: now - 30 * 24 * 60 * 60 * 1000 };
    const atBoundary = restoreAiRecoveryEntries(
      serializeAiRecoveryEntries([entry]), now,
    );
    expect(atBoundary).toEqual([entry]);
    const beyond = restoreAiRecoveryEntries(
      serializeAiRecoveryEntries([{ ...entry, updatedAt: entry.updatedAt - 1 }]), now,
    );
    expect(beyond).toEqual([]);
  });

  it("isolates recovery records by account and operation", () => {
    expect(aiRecoveryStorageScope("user-a", "image.generate"))
      .not.toBe(aiRecoveryStorageScope("user-b", "image.generate"));
    expect(aiRecoveryStorageScope("user-a", "image.generate"))
      .not.toBe(aiRecoveryStorageScope("user-a", "audio.transcribe"));
  });

  it("merges interleaved tab writes by digest without losing either key", () => {
    const first = {
      digest: "a".repeat(64), key: "key-a", model: "", capability: null,
      updatedAt: 10,
    };
    const second = {
      digest: "b".repeat(64), key: "key-b", model: "", capability: null,
      updatedAt: 11,
    };
    const tabOne = mergeAiRecoveryEntries([], [first]);
    const tabTwo = mergeAiRecoveryEntries(tabOne, [second]);
    const staleTabOne = mergeAiRecoveryEntries(tabTwo, [first]);

    expect(staleTabOne.map((entry) => entry.key).sort()).toEqual(["key-a", "key-b"]);
  });

  it("lets a newer same-digest mutation win while preserving unrelated entries", () => {
    const original = {
      digest: "c".repeat(64), key: "old-key", model: "", capability: null,
      updatedAt: 20,
    };
    const unrelated = {
      digest: "d".repeat(64), key: "other-key", model: "", capability: null,
      updatedAt: 21,
    };
    const newer = { ...original, key: "new-key", updatedAt: 22 };

    expect(mergeAiRecoveryEntries([original, unrelated], [newer])).toEqual([
      newer,
      unrelated,
    ]);
  });

  it("removes one digest without erasing a concurrent tab's entry", () => {
    const removed = {
      digest: "e".repeat(64), key: "remove-me", model: "", capability: null,
      updatedAt: 30,
    };
    const concurrent = {
      digest: "f".repeat(64), key: "keep-me", model: "", capability: null,
      updatedAt: 31,
    };
    const latest = mergeAiRecoveryEntries([removed], [concurrent]);
    expect(removeAiRecoveryEntry(latest, removed.digest)).toEqual([concurrent]);
  });

  it("keeps a settled-key tombstone from suppressing a new generation", () => {
    const tombstone = serializeAiRecoveryTombstone("settled-key");

    expect(isAiRecoveryTombstoned(tombstone, "settled-key")).toBe(true);
    expect(isAiRecoveryTombstoned(tombstone, "new-generation-key")).toBe(false);
    expect(isAiRecoveryTombstoned("{broken", "settled-key")).toBe(false);
  });

  it("allocates one durable key for two mounted digesting forms", async () => {
    const storage = browserStorage();
    const locks = serialLocks();
    const digest = "f".repeat(64);
    let minted = 0;
    const entries: Array<{ digest: string; key: string; model: string; capability: unknown; updatedAt: number }> = [];
    const allocate = () => acquirePersistedEntry({
      lockName: "beutl.ai.recovery.lock",
      digest,
      model: "model-a",
      capability: null,
      readEntries: () => entries,
      writeEntry: (entry) => { entries.push(entry); storage.setItem(entry.digest, JSON.stringify(entry)); return true; },
      createKey: () => `key-${++minted}`,
      locks,
    });
    const [first, second] = await Promise.all([allocate(), allocate()]);
      expect(first?.key).toBe("key-1");
      expect(second?.key).toBe("key-1");
      expect(minted).toBe(1);
  });

  it("fails closed for a new digest when persistence or locks are unavailable", async () => {
    const storage = browserStorage();
    const entries: Array<{ digest: string; key: string; model: string; capability: unknown; updatedAt: number }> = [];
    await expect(acquirePersistedEntry({
      lockName: "beutl.ai.recovery.lock",
      digest: "e".repeat(64),
      model: "model-a",
      capability: null,
      readEntries: () => entries,
      writeEntry: (entry) => { entries.push(entry); storage.setItem(entry.digest, JSON.stringify(entry)); return true; },
      createKey: () => "unsafe",
      locks: undefined,
    })).resolves.toBeNull();
    expect(storage.values.size).toBe(0);
  });

  it("preserves all active identities and refuses a new one at capacity", async () => {
    const storage = browserStorage();
    const locks = serialLocks();
    const entries = Array.from({ length: 64 }, (_, index) => ({
      digest: index.toString(16).padStart(64, "0"),
      key: `key-${index}`,
      model: "model",
      capability: null,
      updatedAt: Date.now() - index,
    }));
    let minted = 0;
    const result = await acquirePersistedEntry({
      lockName: "beutl.ai.recovery.lock",
      digest: "z".repeat(64),
      model: "model",
      capability: null,
      readEntries: () => entries,
      writeEntry: (entry) => { entries.push(entry); storage.setItem(entry.digest, JSON.stringify(entry)); return true; },
      createKey: () => `key-${++minted}`,
      locks,
    });
    expect(result).toBeNull();
    expect(minted).toBe(0);
    expect(entries).toHaveLength(64);
  });

  it("serializes different digests against the shared capacity", async () => {
    const locks = serialLocks();
    const entries = Array.from({ length: 63 }, (_, index) => ({
      digest: index.toString(16).padStart(64, "0"),
      key: `key-${index}`,
      model: "model",
      capability: null,
      updatedAt: Date.now() - index,
    }));
    const allocate = (digest: string) => acquirePersistedEntry({
      // Production uses one account/operation lock for every digest.
      lockName: "beutl.ai.recovery.scope.lock",
      digest,
      model: "model",
      capability: null,
      readEntries: () => entries,
      writeEntry: (entry) => { entries.push(entry); return true; },
      createKey: () => `key-${digest[0]}`,
      locks,
    });

    const outcomes = await Promise.all([
      allocate("a".repeat(64)),
      allocate("b".repeat(64)),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(entries).toHaveLength(64);
  });

  it("keeps physical recovery records bounded after expired generations", () => {
    const now = Date.now();
    const expired = Array.from({ length: 80 }, (_, index) => ({
      digest: index.toString(16).padStart(64, "0"),
      key: `expired-${index}`,
      model: "model",
      capability: null,
      updatedAt: now - AI_RECOVERY_TTL_MS - index - 1,
    }));
    expect(restoreAiRecoveryEntries(serializeAiRecoveryEntries(expired), now)).toEqual([]);
  });

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
      "aiRequestChanged",
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
    let names = readyAiRequestNames(newAiRequestNames(), next);

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

  it("has a name ready before anyone types", () => {
    // 画面はサーバー側でも一度描かれる。そこで作ると描き直したときと食い違うので、
    // 最初の 1 つはブラウザで、人が触るより前に用意する——用意する前に送れると、
    // 空の名前で課金され、その依頼へ戻る道が最初から無い。
    expect(newAiRequestNames().next).toBe("");
    expect(
      readyAiRequestNames(newAiRequestNames(), () => "key-a").next,
    ).toBe("key-a");
  });

  it("mints a name only when one is sent", () => {
    // 書き換えるたびに作っていては、打鍵のたびに使われない名前が積み上がる。
    const next = mint();
    const names = readyAiRequestNames(newAiRequestNames(), next);

    expect(aiRequestNameOf(names, "half-typed"))
      .toBe(aiRequestNameOf(names, "half-typed-more"));
    expect(holdsAiRequestName(names, "half-typed")).toBe(false);
  });

  it("keeps the name of a request that is still running", () => {
    const next = mint();
    let names = readyAiRequestNames(newAiRequestNames(), next);
    const sent = aiRequestNameOf(names, "request");
    names = commitAiRequestName(names, "request", next);

    names = settleAiRequestName(names, true);

    expect(aiRequestNameOf(names, "request")).toBe(sent);
    expect(holdsAiRequestName(names, "request")).toBe(true);
  });

  it("does not rotate a key after a parallel body conflict", () => {
    const next = mint();
    let names = readyAiRequestNames(newAiRequestNames(), next);
    const key = aiRequestNameOf(names, "request");
    names = reduceAiRequestRecovery(names, {
      type: "commit",
      request: "request",
    }, next);

    // aiRequestChanged is recoverable: restore the original body and submit
    // it again under the same key so the already-reserved job is replayed.
    names = reduceAiRequestRecovery(names, { type: "settle", keeps: true });
    expect(aiRequestNameOf(names, "request")).toBe(key);
    expect(holdsAiRequestName(names, "request")).toBe(true);
  });

  it("sends the same request under the name it already has", () => {
    // 中身を戻したなら、それは同じ依頼。新しい名前を作ると、支払い済みのものを
    // もう一度買うことになる。
    const next = mint();
    let names = readyAiRequestNames(newAiRequestNames(), next);
    const first = aiRequestNameOf(names, "request");
    names = commitAiRequestName(names, "request", next);
    names = commitAiRequestName(names, "other", next);

    expect(aiRequestNameOf(names, "request")).toBe(first);
    names = commitAiRequestName(names, "request", next);
    expect(aiRequestNameOf(names, "request")).toBe(first);
  });

  it("keeps model identity and capability snapshots per outstanding request", () => {
    const next = mint();
    let names = readyAiRequestNames(newAiRequestNames(), next);
    names = reduceAiRequestRecovery(names, {
      type: "commit",
      request: "request-a",
      model: "removed-model",
      capability: { seed: false },
    }, next);
    names = reduceAiRequestRecovery(names, {
      type: "commit",
      request: "request-b",
      model: "removed-model",
      capability: { seed: true },
    }, next);

    expect(names.heldModels).toEqual({
      "request-a": "removed-model",
      "request-b": "removed-model",
    });
    expect(names.heldCapabilities).toEqual({
      "request-a": { seed: false },
      "request-b": { seed: true },
    });
    // While any request is outstanding, the first capability is frozen for the
    // model. The second request therefore cannot accidentally use a refreshed
    // catalog and produce a third signature.
    expect(mergeHeldRequestCapabilities(
      {},
      names.heldCapabilities,
      names.heldModels,
    )).toEqual({ "removed-model": { seed: false } });

    const bKey = aiRequestNameOf(names, "request-b");
    names = reduceAiRequestRecovery(names, { type: "settle", keeps: false });
    expect(names.heldCapabilities["request-b"]).toBeUndefined();
    expect(names.heldCapabilities["request-a"]).toEqual({ seed: false });

    // Replaying A still uses its original key and body option after the
    // catalog has changed; B had a separate key before it settled.
    expect(aiRequestNameOf(names, "request-a")).toBe("name-1");
    expect(bKey).toBe("name-2");
    expect(names.heldModels["request-a"]).toBe("removed-model");
    expect(names.heldModels["request-b"]).toBeUndefined();
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
    // 選べる形で残す。選べないと、その名前が指す支払い済みの結果へ戻れない。
    expect(kept.at(-1)?.available).toBe(true);
  });

  it("preserves a removed model only while its paid request is outstanding", () => {
    expect(correctedModelId([], "model-gone", true)).toBe("model-gone");
    expect(correctedModelId([
      { id: "model-b", displayName: "B", costTier: null, available: true },
    ], "model-gone", true)).toBe("model-gone");
    expect(correctedModelId([
      { id: "model-b", displayName: "B", costTier: null, available: true },
    ], "model-gone", false)).toBe("model-b");
  });

  it("does not let a held model bless a different request", () => {
    let names = readyAiRequestNames(newAiRequestNames(), () => "key-a");
    names = commitAiRequestName(names, "request-a", () => "key-b", "model-gone");
    expect(holdsAiRequestName(names, "request-a")).toBe(true);
    expect(holdsAiRequestName(names, "request-b")).toBe(false);
    expect(holdsAiRequestModel(names, "model-gone")).toBe(true);
    expect(correctedModelId(offered, "model-gone", true)).toBe("model-gone");
    expect(canSubmitModelRequest(offered, "model-gone", true, false)).toBe(false);
    expect(canSubmitModelRequest(offered, "model-x", true, false)).toBe(false);
    expect(canSubmitModelRequest(offered, "model-x", true, true)).toBe(true);
  });

  it("keeps a removed held model selected while restoring A after A to B", () => {
    const catalog = [
      { id: "model-b", displayName: "B", costTier: null, available: true },
    ] as const;
    let names = readyAiRequestNames(newAiRequestNames(), () => "key-a");
    names = commitAiRequestName(names, "request-a", () => "key-b", "model-a");
    names = settleAiRequestName(names, true);
    names = commitAiRequestName(names, "request-b", () => "key-c", "model-b");
    names = settleAiRequestName(names, true);

    // The catalog can briefly be empty during a refresh. The held A identity
    // must survive that render and the later B catalog, rather than converging
    // to an empty/default model.
    expect(correctedModelId([], "model-a", true)).toBe("model-a");
    expect(correctedModelId(catalog, "model-a", true)).toBe("model-a");
    expect(
      modelsWithHeldRequests(catalog, heldAiRequestModels(names)).map(
        (entry) => entry.id,
      ),
    ).toEqual(["model-b", "model-a"]);
    expect(correctedModelId(catalog, "model-a", true)).toBe("model-a");
    // Merely selecting A is not a new paid run: its fields must first restore
    // the exact held signature. Once restored, the original key is reused.
    expect(canSubmitModelRequest(catalog, "model-a", true, false)).toBe(false);
    expect(canSubmitModelRequest(catalog, "model-a", true, true)).toBe(true);
    expect(aiRequestNameOf(names, "request-a")).toBe("key-a");
    expect(aiRequestNameOf(names, "request-b")).toBe("key-b");
  });

  it("freezes capability snapshots for removed held models", () => {
    const snapshots: Record<string, {
      aspectRatios?: string[];
      seed?: boolean;
      generateAudio?: boolean;
      firstFrame?: boolean;
      lastFrame?: boolean;
    }> = {};
    const first = mergeHeldModelCapabilities(
      {
        "model-a": {
          aspectRatios: ["1:1"],
          seed: false,
          generateAudio: false,
          firstFrame: false,
          lastFrame: true,
        },
      },
      snapshots,
      [],
    );
    expect(first["model-a"]?.aspectRatios).toEqual(["1:1"]);
    expect(first["model-a"]?.seed).toBe(false);
    const afterRemoval = mergeHeldModelCapabilities(
      {},
      snapshots,
      ["model-a"],
    );
    expect(afterRemoval["model-a"]?.generateAudio).toBe(false);
    expect(afterRemoval["model-a"]?.firstFrame).toBe(false);
    expect(afterRemoval["model-a"]?.lastFrame).toBe(true);
    expect(afterRemoval["model-a"]?.seed).toBe(false);
    const afterMutation = mergeHeldModelCapabilities(
      { "model-a": { seed: true } },
      snapshots,
      ["model-a"],
    );
    expect(afterMutation["model-a"]?.seed).toBe(false);
    const afterSettle = mergeHeldModelCapabilities(
      { "model-b": { seed: true } },
      snapshots,
      [],
    );
    expect(afterSettle["model-a"]).toBeUndefined();
  });

  it("freezes an absent capability before it appears for a held request", () => {
    const snapshots: Record<string, { seed?: boolean } | null> = {};
    expect(
      mergeHeldModelCapabilities({}, snapshots, [], ["model-a"])["model-a"],
    ).toBeUndefined();

    // The original request used unrestricted fallback semantics. Once it is
    // held, a provider recovery that publishes restrictions must not change it.
    const appeared = mergeHeldModelCapabilities(
      { "model-a": { seed: false } },
      snapshots,
      ["model-a"],
      ["model-a"],
    );
    expect(appeared["model-a"]).toBeUndefined();

    const afterSettle = mergeHeldModelCapabilities(
      { "model-a": { seed: false } },
      snapshots,
      [],
      ["model-a"],
    );
    expect(afterSettle["model-a"]?.seed).toBe(false);
  });

  it("remembers the original model alongside an idempotency key", () => {
    let names = readyAiRequestNames(newAiRequestNames(), () => "key-a");
    names = commitAiRequestName(names, "request-a", () => "key-b", "model-gone");
    expect(names.heldModels["request-a"]).toBe("model-gone");
    names = settleAiRequestName(names, false);
    expect(names.heldModels["request-a"]).toBeUndefined();
  });

  it("retains an explicit model-less identity while it is outstanding", () => {
    let names = readyAiRequestNames(newAiRequestNames(), () => "key-a");
    names = commitAiRequestName(names, "request-a", () => "key-b", "");
    expect(correctedModelId(offered, "", true)).toBe("");
    expect(names.heldModels["request-a"]).toBe("");
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

  it("leaves room for the result the screen sends back with the next request", () => {
    // useActionState は前回の state を次の本文に載せる。切れ端を持ち帰る画面は
    // 前回の文字起こしを丸ごと連れてくるので、そのぶんを見ておかないと、
    // 正しい大きさの音声が届く前に断られる。
    const transcribe = aiScreenUploadLimit("/ja/dashboard/ai/transcribe");
    expect(transcribe).toBeGreaterThan(
      MAX_AI_TRANSCRIPTION_UPLOAD_BYTES + MAX_AI_RESULT_BYTES,
    );
    // 持ち帰らない画面まで広げはしない。
    expect(aiScreenUploadLimit("/ja/dashboard/ai/edit")).toBeLessThan(
      MAX_AI_IMAGE_UPLOAD_BYTES + MAX_AI_RESULT_BYTES,
    );
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
    // どちらへも戻れる。片方しか選べないと、もう一方は取り残される。
    expect(kept.every((model) => model.available)).toBe(true);
  });
});

describe("what the AI upload guard refuses", () => {
  function requestOf(pathname: string, headers: Record<string, string>) {
    return {
      method: "POST",
      nextUrl: { pathname },
      headers: new Headers(headers),
    } as unknown as Parameters<typeof refuseOversizedAiUpload>[0];
  }

  it("refuses a body larger than the screen it names", () => {
    const over = String(MAX_AI_IMAGE_UPLOAD_BYTES * 4);
    expect(
      refuseOversizedAiUpload(requestOf("/ja/dashboard/ai/edit", {
        "content-length": over,
      }))?.status,
    ).toBe(413);
    expect(
      refuseOversizedAiUpload(requestOf("/ja/dashboard/ai/edit", {
        "content-length": "1024",
      })),
    ).toBeNull();
  });

  it("refuses a body that does not say how long it is", () => {
    // 量が分からないまま通すことになる。この画面へ本文を送るのはブラウザの
    // フォームと Server Action だけで、どちらも長さを付ける。
    expect(
      refuseOversizedAiUpload(requestOf("/ja/dashboard/ai/edit", {}))?.status,
    ).toBe(411);
  });

  it("says nothing about a path it does not know", () => {
    // Server Action は URL ではなく Next-Action ヘッダーの ID で選ばれるので、
    // AI の Action は AI 以外のパスへも POST できる——ここは境界ではなく、
    // 間違って大きなものを選んだ普通の利用者のための入口の狭めでしかない。
    expect(
      refuseOversizedAiUpload(requestOf("/ja/dashboard", {
        "content-length": String(MAX_AI_IMAGE_UPLOAD_BYTES * 4),
        "next-action": "abcdef0123456789",
      })),
    ).toBeNull();
  });

  it("leaves anything that is not a POST alone", () => {
    const get = {
      method: "GET",
      nextUrl: { pathname: "/ja/dashboard/ai/edit" },
      headers: new Headers({}),
    } as unknown as Parameters<typeof refuseOversizedAiUpload>[0];
    expect(refuseOversizedAiUpload(get)).toBeNull();
  });
});
