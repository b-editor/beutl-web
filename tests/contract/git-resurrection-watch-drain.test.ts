import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 見張りを始める瞬間、古い Worker が処理中の消去はまだ残っている。控えを書かない
// 古いコードがそれを完了させると、見張りの開始より後の消去なのに控えが無い、という
// 行き違いが残る。**その後に取った控えから戻すと、生き返っても数に出ない。**
//
// 流し切ったかどうかは、この側からは見えない (止めるのは git-server 側の Caddy と
// 画面の側)。見えないものを済んだことにはしないので、この配備より前から利用者が
// いたなら明示させる。
//
// 開始時刻は一度入ると動かせない (前へも後ろへも動かさない作り) ので、間違って
// 始めたものは残り続ける。だから始める前に止める。

const { requireDrain } = await import(
  "../../apps/web/scripts/git-start-resurrection-watch.mjs"
);

const DEPLOY_STARTED = new Date("2026-08-30T02:00:00Z");
const TOMBSTONES_APPLIED = new Date("2026-08-26T00:00:00Z");

/**
 * 行の作成時刻を持たせた stub。**数える側が境界で絞ることまで確かめる。**
 * 絞らない実装でも「今の数」で通ってしまうテストにはしない。
 */
function prismaWith({
  accountsAt = [] as Date[],
  credentialsAt = [] as Date[],
  tombstonesAppliedAt = TOMBSTONES_APPLIED as Date | null,
  missingTables = false,
} = {}) {
  const countBefore = (rows: Date[]) => async (args?: any) => {
    if (missingTables) {
      throw Object.assign(new Error("relation does not exist"), {
        code: "P2021",
      });
    }
    const boundary = args?.where?.createdAt?.lt;
    if (!boundary) throw new Error("境界で絞っていません");
    return rows.filter((at) => at < boundary).length;
  };
  return {
    gitAccount: { count: countBefore(accountsAt) },
    gitCredential: { count: countBefore(credentialsAt) },
    $queryRaw: async () =>
      tombstonesAppliedAt ? [{ finished_at: tombstonesAppliedAt }] : [],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-30T02:30:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.BEUTL_GIT_DRAINED;
  delete process.env.BEUTL_GIT_DEPLOY_STARTED_AT;
  vi.restoreAllMocks();
});

function quiet() {
  vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("見張りを始める前の drain", () => {
  it("初回配備では黙って通る", async () => {
    process.env.BEUTL_GIT_DEPLOY_STARTED_AT = DEPLOY_STARTED.toISOString();
    await expect(requireDrain(prismaWith())).resolves.toBeUndefined();
  });

  it("表がまだ無ければ通る (Git を提供したことが無い)", async () => {
    process.env.BEUTL_GIT_DEPLOY_STARTED_AT = DEPLOY_STARTED.toISOString();
    await expect(
      requireDrain(prismaWith({ missingTables: true })),
    ).resolves.toBeUndefined();
  });

  // **これが本題。** release は smoke test で GET /api/v3/git/account を叩き、
  // そこで GitAccount が 1 件できる。今の数を見ると、初回配備が自分の副作用で
  // 止まる (実際にそうなっていた)。しかも止まるのは migration と Worker 配備の
  // 後で、残った行はやり直しでも「既存の利用者」に見える。
  it("配備が始まった後に smoke が作った行では止まらない", async () => {
    process.env.BEUTL_GIT_DEPLOY_STARTED_AT = DEPLOY_STARTED.toISOString();
    const smokeCreated = new Date("2026-08-30T02:10:00Z");
    await expect(
      requireDrain(prismaWith({ accountsAt: [smokeCreated] })),
    ).resolves.toBeUndefined();
  });

  it("やり直しでも、前回の smoke の行では止まらない", async () => {
    // release が落ちた後、単独で実行する場合。境界は控えの表ができた時点。
    const smokeCreated = new Date("2026-08-29T12:00:00Z");
    await expect(
      requireDrain(prismaWith({ accountsAt: [smokeCreated] })),
    ).resolves.toBeUndefined();
  });

  it("配備より前からのアカウントがあれば断る", async () => {
    quiet();
    process.env.BEUTL_GIT_DEPLOY_STARTED_AT = DEPLOY_STARTED.toISOString();
    await expect(
      requireDrain(prismaWith({ accountsAt: [new Date("2026-08-20T00:00:00Z")] })),
    ).rejects.toThrow(/refusing to start the resurrection watch/);
  });

  it("資格情報だけでも断る", async () => {
    quiet();
    process.env.BEUTL_GIT_DEPLOY_STARTED_AT = DEPLOY_STARTED.toISOString();
    // アカウントを消しても端末に配ったトークンは残りうる。片方だけを見ると
    // 「利用者がいない」と読んで通してしまう。
    await expect(
      requireDrain(
        prismaWith({ credentialsAt: [new Date("2026-08-20T00:00:00Z")] }),
      ),
    ).rejects.toThrow(/refusing to start the resurrection watch/);
  });

  it("単独実行では控えの表ができた時点を境界にする", async () => {
    quiet();
    await expect(
      requireDrain(prismaWith({ accountsAt: [new Date("2026-08-25T00:00:00Z")] })),
    ).rejects.toThrow(/refusing to start the resurrection watch/);
  });

  it("境界を決められなければ断る", async () => {
    quiet();
    // 分からないものを「利用者はいない」と読むと、検査そのものが意味を失う。
    await expect(
      requireDrain(prismaWith({ tombstonesAppliedAt: null })),
    ).rejects.toThrow(/cannot determine when this deployment began/);
  });
});

describe("流し切ったという申告", () => {
  const upgrading = () =>
    prismaWith({ accountsAt: [new Date("2026-08-20T00:00:00Z")] });

  it("直前の時刻なら通る", async () => {
    process.env.BEUTL_GIT_DEPLOY_STARTED_AT = DEPLOY_STARTED.toISOString();
    process.env.BEUTL_GIT_DRAINED = "2026-08-30T02:20:00Z";
    await expect(requireDrain(upgrading())).resolves.toBeUndefined();
  });

  it("時刻でない値では通さない", async () => {
    quiet();
    process.env.BEUTL_GIT_DEPLOY_STARTED_AT = DEPLOY_STARTED.toISOString();
    // 固定値だと、shell に残った古い値が別の配備をそのまま通してしまう。
    process.env.BEUTL_GIT_DRAINED = "1";
    await expect(requireDrain(upgrading())).rejects.toThrow(
      /refusing to start the resurrection watch/,
    );
  });

  it("古すぎる値では通さない", async () => {
    quiet();
    process.env.BEUTL_GIT_DEPLOY_STARTED_AT = DEPLOY_STARTED.toISOString();
    // 流し切ってから配るまでの間に、口が開いていた可能性がある。
    process.env.BEUTL_GIT_DRAINED = "2026-08-29T02:20:00Z";
    await expect(requireDrain(upgrading())).rejects.toThrow(
      /refusing to start the resurrection watch/,
    );
  });

  it("未来の時刻では通さない", async () => {
    quiet();
    process.env.BEUTL_GIT_DEPLOY_STARTED_AT = DEPLOY_STARTED.toISOString();
    process.env.BEUTL_GIT_DRAINED = "2026-08-30T04:00:00Z";
    await expect(requireDrain(upgrading())).rejects.toThrow(
      /refusing to start the resurrection watch/,
    );
  });

  it("断るときは、何をすればよいかを出す", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => {
      errors.push(String(m));
    });
    process.env.BEUTL_GIT_DEPLOY_STARTED_AT = DEPLOY_STARTED.toISOString();
    await expect(requireDrain(upgrading())).rejects.toThrow();
    expect(errors.join("\n")).toContain("quiesce-canary.sh");
    expect(errors.join("\n")).toContain("BEUTL_GIT_DRAINED");
  });
});
