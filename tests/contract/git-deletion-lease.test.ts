import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaTransaction } from "@beutl/db";

// 退会の印に持たせた期限の意味を固定する。
//
// 印を立てた処理が落ちると、その利用者は退会も資格情報の発行もできなくなる。
// 期限はそこから抜け出すための唯一の経路なので、「期限内は誰も触れない」ことと
// 「期限が切れたら必ず引き取れる」ことの両方が要る。
//
// 検査するのは本物の db 層の where 句。フェイクの Prisma に差し替えて、
// 条件付き更新が意図した行だけを掴むかを見る (orderBy は解釈しない)。

type Row = {
  userId: string;
  intentId: string;
  phase: string;
  forgejoUsername: string | null;
  forgejoUserId: number | null;
  createdAt: Date;
  leaseUntil: Date | null;
  purgedAt: Date | null;
  checkedGeneration: string | null;
  attempts: number;
  lastAttemptAt: Date | null;
  lastError: string | null;
};

const rows = new Map<string, Row>();
let liveUsers = new Set<string>();
let audited: { action: string; details: string | null }[] = [];
/** 今の復元世代。確認した墓標に書かれることを確かめる。 */
let generation: string | null = "gen-1";

type Filter = Record<string, unknown>;

function matches(row: Row, where: Filter): boolean {
  for (const [key, expected] of Object.entries(where)) {
    if (key === "OR") {
      if (!(expected as Filter[]).some((clause) => matches(row, clause))) {
        return false;
      }
      continue;
    }
    if (key === "AND") {
      if (!(expected as Filter[]).every((clause) => matches(row, clause))) {
        return false;
      }
      continue;
    }
    const actual = (row as unknown as Record<string, unknown>)[key];
    if (
      expected !== null &&
      typeof expected === "object" &&
      !(expected instanceof Date)
    ) {
      const range = expected as { lt?: Date; not?: unknown };
      if ("not" in range) {
        if (actual === range.not) return false;
        continue;
      }
      if (!("lt" in range)) {
        throw new Error(`unsupported filter: ${JSON.stringify(expected)}`);
      }
      // NULL は比較の対象外。SQL と同じく一致しない。
      if (!(actual instanceof Date) || !(actual < (range.lt as Date))) {
        return false;
      }
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

function applyData(row: Row, data: Record<string, unknown>) {
  for (const [key, value] of Object.entries(data)) {
    const target = row as unknown as Record<string, unknown>;
    if (
      value !== null &&
      typeof value === "object" &&
      !(value instanceof Date) &&
      "increment" in (value as Record<string, unknown>)
    ) {
      target[key] =
        (target[key] as number) +
        ((value as { increment: number }).increment as number);
      continue;
    }
    target[key] = value;
  }
}

const fakeDb = {
  gitAccountDeletion: {
    async updateMany({ where, data }: { where: Filter; data: Filter }) {
      let count = 0;
      for (const row of rows.values()) {
        if (!matches(row, where)) continue;
        applyData(row, data as Record<string, unknown>);
        count += 1;
      }
      return { count };
    },
    async upsert({
      where,
      create,
      update,
    }: {
      where: { userId: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) {
      const existing = rows.get(where.userId);
      if (existing) {
        applyData(existing, update);
        return { ...existing };
      }
      const row: Row = {
        userId: create.userId as string,
        intentId: create.intentId as string,
        phase: "BLOCKING",
        forgejoUsername: null,
        forgejoUserId: null,
        createdAt: new Date(),
        leaseUntil: (create.leaseUntil as Date) ?? null,
        purgedAt: null,
        checkedGeneration: null,
        attempts: 0,
        lastAttemptAt: null,
        lastError: null,
      };
      rows.set(row.userId, row);
      return { ...row };
    },
    async findMany({ where, take }: { where: Filter; take?: number }) {
      return [...rows.values()]
        .filter((row) => matches(row, where))
        .slice(0, take)
        .map((row) => ({ ...row }));
    },
    async findUnique({ where }: { where: { userId: string } }) {
      const row = rows.get(where.userId);
      return row ? { ...row } : null;
    },
    async deleteMany({ where }: { where: Filter }) {
      let count = 0;
      for (const [key, row] of [...rows]) {
        if (!matches(row, where)) continue;
        rows.delete(key);
        count += 1;
      }
      return { count };
    },
    async count({ where }: { where: Filter }) {
      return [...rows.values()].filter((row) => matches(row, where)).length;
    },
  },
};

const prisma = fakeDb as unknown as PrismaTransaction;

// 本物の db 層に、その場のフェイクを渡して呼び直す。where 句は本物のまま。
vi.mock("@beutl/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@beutl/db")>();
  type Args = Record<string, unknown>;
  const withFake =
    <T>(fn: (args: Args) => Promise<T>) =>
    (args: Args = {}) =>
      fn({ ...args, prisma });
  return {
    ...actual,
    existsUserById: async ({ id }: { id: string }) => liveUsers.has(id),
    createAuditLog: async ({
      action,
      details,
    }: {
      action: string;
      details?: string | null;
    }) => {
      audited.push({ action, details: details ?? null });
      return undefined;
    },
    listExpiredGitAccountDeletionBlocks: withFake(
      actual.listExpiredGitAccountDeletionBlocks,
    ),
    releaseGitAccountDeletionBlock: withFake(
      actual.releaseGitAccountDeletionBlock,
    ),
    markGitAccountDeletionNeedsReview: withFake(
      actual.markGitAccountDeletionNeedsReview,
    ),
    countGitAccountDeletionsNeedingReview: withFake(
      actual.countGitAccountDeletionsNeedingReview,
    ),
    listPurgedGitAccountDeletions: withFake(actual.listPurgedGitAccountDeletions),
    countPurgedGitAccountDeletionsToCheck: withFake(
      actual.countPurgedGitAccountDeletionsToCheck,
    ),
    markGitAccountDeletionPurged: withFake(actual.markGitAccountDeletionPurged),
    touchGitAccountDeletion: withFake(actual.touchGitAccountDeletion),
    claimGitAccountDeletion: withFake(actual.claimGitAccountDeletion),
    renewGitAccountDeletionLease: withFake(actual.renewGitAccountDeletionLease),
    recordGitAccountDeletionAttempt: withFake(
      actual.recordGitAccountDeletionAttempt,
    ),
    findGitAccountByUserId: async () => null,
    currentGitRestoreGeneration: async () => generation,
  };
});

const {
  GitAccountDeletionPhase,
  claimGitAccountDeletion,
  deleteGitAccountDeletion,
  markGitAccountDeletionNeedsReview,
  markGitAccountDeletionReady,
  renewGitAccountDeletionLease,
  startGitAccountDeletion,
} = await import("@beutl/db");
const {
  releaseExpiredGitAccountDeletionBlocks,
  reconcileGitAccountDeletionTombstones,
} = await import("@beutl/forgejo");

const future = () => new Date(Date.now() + 60_000);
const past = () => new Date(Date.now() - 60_000);

/** 印を立てて purge 待ちまで進める。 */
async function ready(intentId: string, leaseUntil: Date) {
  await startGitAccountDeletion({
    userId: "u1",
    intentId,
    leaseUntil,
    prisma,
  });
  await markGitAccountDeletionReady({ userId: "u1", intentId, prisma });
}

/** 墓標を 1 つ置く。控えた相手は forgejo 上の someone / id 2。 */
function tombstone(overrides: Partial<Row> = {}) {
  rows.set("u1", {
    userId: "u1",
    intentId: "old",
    phase: GitAccountDeletionPhase.PURGED,
    forgejoUsername: "someone",
    forgejoUserId: 2,
    createdAt: new Date(0),
    leaseUntil: null,
    purgedAt: new Date(0),
    checkedGeneration: null,
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    ...overrides,
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  rows.clear();
  liveUsers = new Set(["u1"]);
  audited = [];
  generation = "gen-1";
  process.env.FORGEJO_BASE_URL = "https://git.example.test";
  process.env.FORGEJO_ADMIN_TOKEN = "admin-token";
  process.env.FORGEJO_PROXY_SECRET = "proxy-secret";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.FORGEJO_BASE_URL;
  delete process.env.FORGEJO_ADMIN_TOKEN;
  delete process.env.FORGEJO_PROXY_SECRET;
});

describe("進行中の退会が持つ期限", () => {
  it("期限が残っている間は、後から来た要求が乗れない", async () => {
    const first = await startGitAccountDeletion({
      userId: "u1",
      intentId: "a",
      leaseUntil: future(),
      prisma,
    });
    const second = await startGitAccountDeletion({
      userId: "u1",
      intentId: "b",
      leaseUntil: future(),
      prisma,
    });

    expect(first).toMatchObject({ owned: true, tookOver: false });
    expect(second).toMatchObject({ intentId: "a", owned: false });
  });

  it("期限が切れていれば引き取れる (印を立てた直後に落ちた場合の唯一の出口)", async () => {
    await startGitAccountDeletion({
      userId: "u1",
      intentId: "dead",
      leaseUntil: past(),
      prisma,
    });

    const taken = await startGitAccountDeletion({
      userId: "u1",
      intentId: "fresh",
      leaseUntil: future(),
      prisma,
    });

    expect(taken).toMatchObject({
      intentId: "fresh",
      owned: true,
      tookOver: true,
    });
  });

  it("引き取られた側は、もうユーザーを消せない", async () => {
    await startGitAccountDeletion({
      userId: "u1",
      intentId: "dead",
      leaseUntil: past(),
      prisma,
    });
    await startGitAccountDeletion({
      userId: "u1",
      intentId: "fresh",
      leaseUntil: future(),
      prisma,
    });

    // 印は引き取られている。ここが通ると、後始末できないままユーザーだけが消える。
    await expect(
      markGitAccountDeletionReady({ userId: "u1", intentId: "dead", prisma }),
    ).rejects.toThrow(/updated 0/);
  });

  it("延長は自分の印にしか効かない", async () => {
    await startGitAccountDeletion({
      userId: "u1",
      intentId: "a",
      leaseUntil: past(),
      prisma,
    });
    await startGitAccountDeletion({
      userId: "u1",
      intentId: "b",
      leaseUntil: future(),
      prisma,
    });

    await expect(
      renewGitAccountDeletionLease({
        userId: "u1",
        intentId: "a",
        phase: GitAccountDeletionPhase.BLOCKING,
        leaseUntil: future(),
        prisma,
      }),
    ).resolves.toBe(false);
    await expect(
      renewGitAccountDeletionLease({
        userId: "u1",
        intentId: "b",
        phase: GitAccountDeletionPhase.BLOCKING,
        leaseUntil: future(),
        prisma,
      }),
    ).resolves.toBe(true);
  });

  it("purge 待ちは、期限を握っている間は他の実行が掴めない", async () => {
    await ready("a", past());

    await expect(
      claimGitAccountDeletion({
        userId: "u1",
        intentId: "cron-1",
        leaseUntil: future(),
        prisma,
      }),
    ).resolves.toBe(true);
    await expect(
      claimGitAccountDeletion({
        userId: "u1",
        intentId: "cron-2",
        leaseUntil: future(),
        prisma,
      }),
    ).resolves.toBe(false);
  });
});

describe("引き取られた実行を締め出す", () => {
  it("引き取られたら期限を延ばせない", async () => {
    // 期限だけ延ばす作りだと、期限切れで引き取られた側が息を吹き返しても
    // renew に成功し、引き取った側と同時に消しにいける。
    await ready("worker-a", past());
    await claimGitAccountDeletion({
      userId: "u1",
      intentId: "worker-b",
      leaseUntil: future(),
      prisma,
    });

    await expect(
      renewGitAccountDeletionLease({
        userId: "u1",
        intentId: "worker-a",
        phase: GitAccountDeletionPhase.READY_TO_PURGE,
        leaseUntil: future(),
        prisma,
      }),
    ).resolves.toBe(false);
  });

  it("引き取られたら人の確認待ちにも移せない", async () => {
    await ready("worker-a", past());
    await claimGitAccountDeletion({
      userId: "u1",
      intentId: "worker-b",
      leaseUntil: future(),
      prisma,
    });

    await markGitAccountDeletionNeedsReview({
      userId: "u1",
      intentId: "worker-a",
      reason: "stale worker",
      prisma,
    });
    expect(rows.get("u1")?.phase).toBe(
      GitAccountDeletionPhase.READY_TO_PURGE,
    );
  });

  it("引き取られたら、引き取った側が残した記録を消せない", async () => {
    // 相手が別人と判定して人の確認待ちに移した行を、古い実行が「片付いた」と
    // 見なして消してしまうと、Forgejo にアカウントが残ったまま追えなくなる。
    await ready("worker-a", past());
    await claimGitAccountDeletion({
      userId: "u1",
      intentId: "worker-b",
      leaseUntil: future(),
      prisma,
    });
    await markGitAccountDeletionNeedsReview({
      userId: "u1",
      intentId: "worker-b",
      reason: "identity mismatch",
      prisma,
    });

    await deleteGitAccountDeletion({
      userId: "u1",
      intentId: "worker-a",
      prisma,
    });
    expect(rows.get("u1")?.phase).toBe(GitAccountDeletionPhase.NEEDS_REVIEW);
  });

  it("人の確認待ちに移った行は、握っていた側でも延長できない", async () => {
    await ready("worker-a", future());
    await markGitAccountDeletionNeedsReview({
      userId: "u1",
      intentId: "worker-a",
      reason: "identity mismatch",
      prisma,
    });

    await expect(
      renewGitAccountDeletionLease({
        userId: "u1",
        intentId: "worker-a",
        phase: GitAccountDeletionPhase.READY_TO_PURGE,
        leaseUntil: future(),
        prisma,
      }),
    ).resolves.toBe(false);
  });
});

describe("落ちた退会処理の印を外す", () => {
  it("利用者が生きているなら外す (発行も退会もできない状態から戻す)", async () => {
    await startGitAccountDeletion({
      userId: "u1",
      intentId: "dead",
      leaseUntil: past(),
      prisma,
    });

    await expect(releaseExpiredGitAccountDeletionBlocks()).resolves.toEqual({
      released: 1,
      review: 0,
    });
    expect(rows.size).toBe(0);
    // 黙って外さない。誰かが後から経緯を追えるようにする。
    expect(audited.map((entry) => entry.action)).toEqual([
      "git.deletionMarkerReleased",
    ]);
  });

  it("期限が残っているものには触らない", async () => {
    await startGitAccountDeletion({
      userId: "u1",
      intentId: "alive",
      leaseUntil: future(),
      prisma,
    });

    await expect(releaseExpiredGitAccountDeletionBlocks()).resolves.toEqual({
      released: 0,
      review: 0,
    });
    expect(rows.size).toBe(1);
  });

  it("利用者が消えているのに BLOCKING なら、人の確認に回す", async () => {
    await startGitAccountDeletion({
      userId: "u1",
      intentId: "dead",
      leaseUntil: past(),
      prisma,
    });
    liveUsers.delete("u1");

    await expect(releaseExpiredGitAccountDeletionBlocks()).resolves.toEqual({
      released: 0,
      review: 1,
    });
    expect(rows.get("u1")).toMatchObject({
      phase: GitAccountDeletionPhase.NEEDS_REVIEW,
      leaseUntil: null,
    });
    // DB を直接見る人がいないと気付けない状態にしない。管理画面から追える形で残す。
    expect(audited.map((entry) => entry.action)).toEqual([
      "git.accountNeedsReview",
    ]);
  });

  it("purge 待ちは外さない (利用者は既に消えている)", async () => {
    await ready("a", past());

    await expect(releaseExpiredGitAccountDeletionBlocks()).resolves.toEqual({
      released: 0,
      review: 0,
    });
    expect(rows.get("u1")?.phase).toBe(
      GitAccountDeletionPhase.READY_TO_PURGE,
    );
  });
});

describe("消したはずのアカウントが戻ってきた場合", () => {
  // Forgejo だけを退会前の時点に復元すると、利用者もリポジトリも端末のトークンも
  // 戻る。beutl-web 側には利用者も進行中の行も残っていないので、墓標が無ければ
  // 誰も気付けない。git と LFS は Caddy を素通りするので、そのまま使えてしまう。
  const purgedUser = {
    id: 2,
    login: "someone",
    email: "u1@users.noreply.git.example.test",
  };

  let searchResult: unknown[] = [];
  let renamedUser: { id: number; login: string; email: string } | null = null;

  beforeEach(() => {
    searchResult = [];
    renamedUser = null;
  });

  function respondWith(user: unknown, tokens: { id: number }[] = []) {
    // 消したトークンは次のページから消える。返し続けると失効の走査が終わらない。
    let remaining = [...tokens];
    fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      const tokenId = path.match(/\/tokens\/(\d+)$/);
      if (method === "DELETE" && tokenId) {
        remaining = remaining.filter((t) => t.id !== Number(tokenId[1]));
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/tokens")) return json(remaining);
      if (path.endsWith("/users/search")) return json({ data: searchResult });
      // 前方一致で見ない。/users/someone-2 は /users/someone を含む。
      if (renamedUser && path.endsWith(`/users/${renamedUser.login}`)) {
        return json(renamedUser);
      }
      if (path.endsWith("/users/someone")) {
        return user === null
          ? json({ message: "not found" }, 404)
          : json(user);
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
  }

  it("控えた相手がそのまま戻っていたら、消し直す", async () => {
    tombstone();
    liveUsers.delete("u1");
    respondWith(purgedUser, [{ id: 7, name: "desktop" }]);

    await expect(
      reconcileGitAccountDeletionTombstones(),
    ).resolves.toMatchObject({ checked: 1, repurged: 1, failed: 0, remaining: 0 });

    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: (init as RequestInit | undefined)?.method ?? "GET",
    }));
    // 復活したトークンを消してから、ユーザーごと消す。
    expect(calls).toContainEqual(
      expect.objectContaining({ method: "DELETE", url: expect.stringContaining("/tokens/7") }),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        method: "DELETE",
        url: expect.stringContaining("/admin/users/someone"),
      }),
    );
    expect(audited.map((entry) => entry.action)).toEqual([
      "git.accountResurrected",
    ]);
    // 墓標は残す。もう一度戻されることがある。
    expect(rows.get("u1")?.phase).toBe(GitAccountDeletionPhase.PURGED);
  });

  it("Beutl 側の利用者が戻っていたら、消さずに人の確認に回す", async () => {
    // 復元されたのは beutl-web の方。その人は生きているので消してはいけない。
    tombstone();
    respondWith(purgedUser);

    await expect(
      reconcileGitAccountDeletionTombstones(),
    ).resolves.toMatchObject({ checked: 1, repurged: 0, review: 1 });
    expect(
      fetchMock.mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toHaveLength(0);
    expect(rows.get("u1")?.phase).toBe(GitAccountDeletionPhase.NEEDS_REVIEW);
  });

  it("名前が別人に渡っていたら消さない", async () => {
    tombstone();
    liveUsers.delete("u1");
    respondWith({ id: 99, login: "someone", email: "someone-else@example.test" });

    await expect(
      reconcileGitAccountDeletionTombstones(),
    ).resolves.toMatchObject({ checked: 1, repurged: 0, review: 0 });
    expect(
      fetchMock.mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toHaveLength(0);
    expect(rows.get("u1")?.phase).toBe(GitAccountDeletionPhase.PURGED);
  });

  it("控えた名前で見つからなくても、合成メールで引き直す", async () => {
    // 復元先で名前が違うことがある。名前だけで諦めると、同じ人が別名で
    // 生き返っていても「消えたまま」と結論してしまう。
    tombstone();
    liveUsers.delete("u1");
    renamedUser = {
      id: 2,
      login: "someone-2",
      email: "u1@users.noreply.git.example.test",
    };
    searchResult = [renamedUser];
    respondWith(null, [{ id: 7, name: "desktop" }]);

    await expect(
      reconcileGitAccountDeletionTombstones(),
    ).resolves.toMatchObject({ checked: 1, repurged: 1 });
    expect(
      fetchMock.mock.calls.map(([url]) => String(url)),
    ).toContainEqual(expect.stringContaining("/admin/users/someone-2"));
  });

  it("消えたままなら何もしない", async () => {
    tombstone();
    liveUsers.delete("u1");
    respondWith(null);

    // 見終わったので lastAttemptAt が進み、残りは 0 になる。
    await expect(
      reconcileGitAccountDeletionTombstones(),
    ).resolves.toMatchObject({ checked: 1, repurged: 0, remaining: 0 });
    expect(rows.get("u1")?.lastAttemptAt).not.toBeNull();
  });

  it("最近見たものは飛ばす (新しい復元が無いとき)", async () => {
    generation = null;
    tombstone({ lastAttemptAt: new Date() });
    liveUsers.delete("u1");
    respondWith(purgedUser);

    await expect(
      reconcileGitAccountDeletionTombstones(),
    ).resolves.toMatchObject({ checked: 0, remaining: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("新しい復元があれば、間隔を待たずに見直す", async () => {
    // 待たせると、復元の後 git を止めている時間が確認の間隔ぶん延びる。
    tombstone({ lastAttemptAt: new Date(), checkedGeneration: "gen-0" });
    liveUsers.delete("u1");
    respondWith(null);

    await expect(
      reconcileGitAccountDeletionTombstones(),
    ).resolves.toMatchObject({ checked: 1, remaining: 0 });
    // 見た世代を書く。これで「この復元より後に確認した」が時計抜きで分かる。
    expect(rows.get("u1")?.checkedGeneration).toBe("gen-1");
  });
});
