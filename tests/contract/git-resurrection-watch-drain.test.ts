import { afterEach, describe, expect, it, vi } from "vitest";

// 見張りを始める瞬間、古い Worker が処理中の消去はまだ残っている。控えを書かない
// 古いコードがそれを完了させると、見張りの開始より後の消去なのに控えが無い、という
// 行き違いが残る。**その後に取った控えから戻すと、生き返っても数に出ない。**
//
// 流し切ったかどうかは、この側からは見えない (止めるのは git-server 側の Caddy と
// 画面の側)。見えないものを済んだことにはしないので、利用者が既にいるなら明示させる。
//
// 開始時刻は一度入ると動かせない (前へも後ろへも動かさない作り) ので、間違って
// 始めたものは残り続ける。だから始める前に止める。

const { requireDrain } = await import(
  "../../apps/web/scripts/git-start-resurrection-watch.mjs"
);

function prismaWith(accounts: number, credentials: number) {
  return {
    gitAccount: { count: async () => accounts },
    gitCredential: { count: async () => credentials },
  };
}

afterEach(() => {
  delete process.env.BEUTL_GIT_DRAINED;
  vi.restoreAllMocks();
});

describe("見張りを始める前の drain", () => {
  it("初回配備では黙って通る", async () => {
    await expect(requireDrain(prismaWith(0, 0))).resolves.toBeUndefined();
  });

  it("アカウントが既にあれば断る", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(requireDrain(prismaWith(3, 0))).rejects.toThrow(
      /refusing to start the resurrection watch/,
    );
  });

  it("資格情報だけでも断る", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // アカウントを消しても端末に配ったトークンは残りうる。片方だけを見ると
    // 「利用者がいない」と読んで通してしまう。
    await expect(requireDrain(prismaWith(0, 1))).rejects.toThrow(
      /refusing to start the resurrection watch/,
    );
  });

  it("流し切ったと明示されていれば通る", async () => {
    process.env.BEUTL_GIT_DRAINED = "1";
    await expect(requireDrain(prismaWith(3, 5))).resolves.toBeUndefined();
  });

  it("1 以外の値では通さない", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // "true" や "yes" を書いて通ったつもりになるのを防ぐ。
    process.env.BEUTL_GIT_DRAINED = "true";
    await expect(requireDrain(prismaWith(3, 5))).rejects.toThrow(
      /refusing to start the resurrection watch/,
    );
  });

  it("断るときは、何をすればよいかを出す", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => {
      errors.push(String(m));
    });
    await expect(requireDrain(prismaWith(1, 0))).rejects.toThrow();
    expect(errors.join("\n")).toContain("quiesce-canary.sh");
    expect(errors.join("\n")).toContain("BEUTL_GIT_DRAINED=1");
  });
});
