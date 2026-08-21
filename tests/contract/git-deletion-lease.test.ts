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
  attempts: number;
  lastAttemptAt: Date | null;
  lastError: string | null;
};

const rows = new Map<string, Row>();
let liveUsers = new Set<string>();
let audited: { action: string; details: string | null }[] = [];

type Filter = Record<string, unknown>;

function matches(row: Row, where: Filter): boolean {
  for (const [key, expected] of Object.entries(where)) {
    if (key === "OR") {
      if (!(expected as Filter[]).some((clause) => matches(row, clause))) {
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
      const range = expected as { lt?: Date };
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
  };
});

const {
  GitAccountDeletionPhase,
  claimGitAccountDeletion,
  markGitAccountDeletionReady,
  renewGitAccountDeletionLease,
  startGitAccountDeletion,
} = await import("@beutl/db");
const { releaseExpiredGitAccountDeletionBlocks } = await import(
  "@beutl/forgejo"
);

const future = () => new Date(Date.now() + 60_000);
const past = () => new Date(Date.now() - 60_000);

beforeEach(() => {
  rows.clear();
  liveUsers = new Set(["u1"]);
  audited = [];
});

afterEach(() => {
  vi.restoreAllMocks();
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
        leaseUntil: future(),
        prisma,
      }),
    ).resolves.toBe(false);
    await expect(
      renewGitAccountDeletionLease({
        userId: "u1",
        intentId: "b",
        leaseUntil: future(),
        prisma,
      }),
    ).resolves.toBe(true);
  });

  it("purge 待ちは、期限を握っている間は他の実行が掴めない", async () => {
    await startGitAccountDeletion({
      userId: "u1",
      intentId: "a",
      leaseUntil: past(),
      prisma,
    });
    await markGitAccountDeletionReady({ userId: "u1", intentId: "a", prisma });

    await expect(
      claimGitAccountDeletion({ userId: "u1", leaseUntil: future(), prisma }),
    ).resolves.toBe(true);
    await expect(
      claimGitAccountDeletion({ userId: "u1", leaseUntil: future(), prisma }),
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
    await startGitAccountDeletion({
      userId: "u1",
      intentId: "a",
      leaseUntil: past(),
      prisma,
    });
    await markGitAccountDeletionReady({ userId: "u1", intentId: "a", prisma });

    await expect(releaseExpiredGitAccountDeletionBlocks()).resolves.toEqual({
      released: 0,
      review: 0,
    });
    expect(rows.get("u1")?.phase).toBe(
      GitAccountDeletionPhase.READY_TO_PURGE,
    );
  });
});
