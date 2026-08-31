import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 見張りを始める瞬間、古い Worker が処理中の消去はまだ残っている。控えを書かない
// 古いコードがそれを完了させると、見張りの開始より後の消去なのに控えが無い、という
// 行き違いが残る。**その後に取った控えから戻すと、生き返っても数に出ない。**
//
// 流し切ったかどうかは、この側からは見えない (止めるのは git-server 側の Caddy と
// 画面の側)。見えないものを済んだことにはしないので、利用者がいるなら明示させる。
//
// 開始時刻は一度入ると動かせない (前へも後ろへも動かさない作り) ので、間違って
// 始めたものは残り続ける。だから始める前に止める。
//
// **時刻で判定しない。** 以前は「この配備が始まった時刻より前の行」を数えていたが、
// 境界は実行ホストの時計・createdAt はデータベースの時計なので、ずれた分だけ判定が
// 入れ替わった。除くのは smoke test が作るアカウント 1 つだけにしてある。

const { requireDrain } = await import(
  "../../apps/web/scripts/git-start-resurrection-watch.mjs"
);

const SMOKE_USER = "smoke-user";

/**
 * 利用者を userId で持たせた stub。**除外条件で絞ることまで確かめる。**
 * 絞らない実装でも「今の数」で通ってしまうテストにはしない。
 */
function prismaWith({
  accounts = [] as string[],
  credentials = [] as string[],
  missingTables = false,
} = {}) {
  const countExcluding = (rows: string[]) => async (args?: any) => {
    if (missingTables) {
      throw Object.assign(new Error("relation does not exist"), {
        code: "P2021",
      });
    }
    const excluded = args?.where?.userId?.not;
    return excluded === undefined
      ? rows.length
      : rows.filter((userId) => userId !== excluded).length;
  };
  return {
    gitAccount: { count: countExcluding(accounts) },
    gitCredential: { count: countExcluding(credentials) },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-31T05:30:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.BEUTL_GIT_DRAINED;
  delete process.env.BEUTL_GIT_SMOKE_USER_ID;
  vi.restoreAllMocks();
});

function quiet() {
  vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("見張りを始める前の drain", () => {
  it("利用者がいなければ黙って通る", async () => {
    await expect(requireDrain(prismaWith())).resolves.toBeUndefined();
  });

  it("表がまだ無ければ通る (Git を提供したことが無い)", async () => {
    await expect(
      requireDrain(prismaWith({ missingTables: true })),
    ).resolves.toBeUndefined();
  });

  // **これが本題。** release は smoke test で GET /api/v3/git/account を叩き、
  // そこで GitAccount が 1 件できる。今の数を見ると、初回配備が自分の副作用で
  // 止まる (実際にそうなっていた)。
  it("smoke が作ったアカウントだけなら止まらない", async () => {
    process.env.BEUTL_GIT_SMOKE_USER_ID = SMOKE_USER;
    await expect(
      requireDrain(prismaWith({ accounts: [SMOKE_USER] })),
    ).resolves.toBeUndefined();
  });

  // 前回の smoke の行が残ったままの再実行。時刻で切っていたときは、境界が毎回
  // 変わるので前回の行が「古い利用者」に化けて止まっていた。
  it("やり直しでも、前回の smoke の行では止まらない", async () => {
    process.env.BEUTL_GIT_SMOKE_USER_ID = SMOKE_USER;
    await expect(
      requireDrain(
        prismaWith({ accounts: [SMOKE_USER], credentials: [SMOKE_USER] }),
      ),
    ).resolves.toBeUndefined();
  });

  it("本物の利用者がいれば断る", async () => {
    quiet();
    process.env.BEUTL_GIT_SMOKE_USER_ID = SMOKE_USER;
    await expect(
      requireDrain(prismaWith({ accounts: [SMOKE_USER, "someone"] })),
    ).rejects.toThrow(/refusing to start the resurrection watch/);
  });

  // 配備の最中に現れた本物の利用者。時刻で切っていたときは smoke と一緒に
  // 除外されていた ——「開始時に 0 件」は初回配備の証明にならない。
  it("配備の最中に現れた利用者も数える", async () => {
    quiet();
    process.env.BEUTL_GIT_SMOKE_USER_ID = SMOKE_USER;
    await expect(
      requireDrain(prismaWith({ credentials: ["someone-else"] })),
    ).rejects.toThrow(/refusing to start the resurrection watch/);
  });

  it("資格情報だけでも断る", async () => {
    quiet();
    // アカウントを消しても端末に配ったトークンは残りうる。片方だけを見ると
    // 「利用者がいない」と読んで通してしまう。
    await expect(
      requireDrain(prismaWith({ credentials: ["someone"] })),
    ).rejects.toThrow(/refusing to start the resurrection watch/);
  });

  it("smoke の指定が無ければ、その分も数える", async () => {
    quiet();
    // release が JWT から持ち主を読めなかった場合。**素通しはしない。**
    await expect(
      requireDrain(prismaWith({ accounts: [SMOKE_USER] })),
    ).rejects.toThrow(/refusing to start the resurrection watch/);
  });

  it("断るときは、何をすればよいかを出す", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => {
      errors.push(String(m));
    });
    await expect(
      requireDrain(prismaWith({ accounts: ["someone"] })),
    ).rejects.toThrow();
    expect(errors.join("\n")).toContain("quiesce-canary.sh");
    expect(errors.join("\n")).toContain("BEUTL_GIT_DRAINED");
  });
});

describe("流し切ったという申告", () => {
  const upgrading = () => prismaWith({ accounts: ["someone"] });

  it("直前に出た receipt の nonce なら通る", async () => {
    // nonce は "<epoch 秒>:<16 進>"。時刻が入っているので古い申告を落とせる。
    process.env.BEUTL_GIT_DRAINED = "1788154000:4f8e86e2a73d0b9d";
    await expect(requireDrain(upgrading())).resolves.toBeUndefined();
  });

  it("時刻だけの値も受ける", async () => {
    process.env.BEUTL_GIT_DRAINED = "2026-08-31T05:20:00Z";
    await expect(requireDrain(upgrading())).resolves.toBeUndefined();
  });

  it("固定値では通さない", async () => {
    quiet();
    // shell に残った古い値が別の配備をそのまま通してしまう。
    process.env.BEUTL_GIT_DRAINED = "1";
    await expect(requireDrain(upgrading())).rejects.toThrow(
      /refusing to start the resurrection watch/,
    );
  });

  it("古すぎる nonce では通さない", async () => {
    quiet();
    // 流し切ってから配るまでの間に、口が開いていた可能性がある。
    process.env.BEUTL_GIT_DRAINED = "1788060000:4f8e86e2a73d0b9d";
    await expect(requireDrain(upgrading())).rejects.toThrow(
      /refusing to start the resurrection watch/,
    );
  });

  it("未来の時刻では通さない", async () => {
    quiet();
    process.env.BEUTL_GIT_DRAINED = "2026-08-31T07:00:00Z";
    await expect(requireDrain(upgrading())).rejects.toThrow(
      /refusing to start the resurrection watch/,
    );
  });
});
