import { describe, expect, it } from "vitest";
import { createPrivateKey, createPublicKey, generateKeyPairSync, verify } from "node:crypto";

// 復元の後に git を開け直すための証拠。ここが静かに壊れると、開けられないか、
// 開けてはいけないものが開く。どちらも復旧の最中にしか分からない。
//
// git-server 側 (scripts/restore.sh) は、同じ 5 行を組み立てて公開鍵で検証する。
// 版・並び・区切りのどれが変わっても、あちらでは検証できなくなる。

const {
  PROOF_PROTOCOL,
  PROOF_TTL_SECONDS,
  SELFTEST_PAYLOAD,
  collectGitReconcileStatus,
  databaseIdentity,
  proofPayload,
  signProof,
} = await import("../../apps/web/scripts/git-reconcile-status.mjs");

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    encodedPrivate: Buffer.from(
      privateKey.export({ type: "pkcs8", format: "pem" }) as string,
      "utf8",
    ).toString("base64"),
    publicKey,
  };
}

describe("証拠の中身", () => {
  it("版・nonce・環境名・接続先・期限を、この順で改行で並べる", () => {
    const payload = proofPayload({
      nonce: "1787536325:c9a7",
      environment: "production",
      database: "db.example:26257/beutl",
      expiresAt: 1787536940,
    });

    expect(payload.split("\n")).toEqual([
      PROOF_PROTOCOL,
      "1787536325:c9a7",
      "production",
      "db.example:26257/beutl",
      "1787536940",
    ]);
  });

  it("版が先頭に入る (判定条件を増やしたときに古い証拠を弾くため)", () => {
    const payload = proofPayload({
      nonce: "n",
      environment: "e",
      database: "d",
      expiresAt: 1,
    });
    expect(payload.startsWith(`${PROOF_PROTOCOL}\n`)).toBe(true);
  });

  it("nonce が違えば中身も違う (別の復元の証拠を使い回せない)", () => {
    const base = { environment: "e", database: "d", expiresAt: 1 };
    expect(proofPayload({ ...base, nonce: "a" })).not.toBe(
      proofPayload({ ...base, nonce: "b" }),
    );
  });
});

describe("接続先の識別", () => {
  it("host:port/database まで含める", () => {
    expect(
      databaseIdentity("postgresql://u:p@db.example.test:26257/beutl"),
    ).toBe("db.example.test:26257/beutl");
  });

  it("同じホストの別データベースは別物として扱う", () => {
    // 本番と staging が同じホストに載っていることがある。ホスト名だけで比べると、
    // staging を見て作った証拠で本番を開けてしまう。
    expect(databaseIdentity("postgresql://h:26257/prod")).not.toBe(
      databaseIdentity("postgresql://h:26257/staging"),
    );
  });

  it("port の指定が無ければ CockroachDB の既定を使う", () => {
    expect(databaseIdentity("postgresql://u@h/beutl")).toBe("h:26257/beutl");
  });
});

describe("有効期限", () => {
  it("git-server 側が受け入れる上限より短い", () => {
    // 同じ値にすると、あちらの時計がわずかに遅れているだけで作りたてが拒まれる。
    // 上限は restore.sh の PROOF_MAX_TTL_SECONDS (900 秒)。
    expect(PROOF_TTL_SECONDS).toBeLessThan(900);
    expect(PROOF_TTL_SECONDS).toBeGreaterThan(0);
  });
});

describe("署名", () => {
  it("対応する公開鍵で検証できる", () => {
    const { encodedPrivate, publicKey } = keypair();
    const payload = proofPayload({
      nonce: "n",
      environment: "e",
      database: "d",
      expiresAt: 2,
    });

    const signature = signProof(payload, encodedPrivate);

    expect(
      verify(null, Buffer.from(payload), publicKey, Buffer.from(signature, "base64")),
    ).toBe(true);
  });

  it("中身が 1 文字でも違えば検証に通らない", () => {
    const { encodedPrivate, publicKey } = keypair();
    const signature = signProof("beutl-reopen-v1\nn\ne\nd\n2", encodedPrivate);

    expect(
      verify(
        null,
        Buffer.from("beutl-reopen-v1\nn\ne\nd\n3"),
        publicKey,
        Buffer.from(signature, "base64"),
      ),
    ).toBe(false);
  });

  it("別の鍵の署名は通らない", () => {
    const a = keypair();
    const b = keypair();
    const payload = "beutl-reopen-v1\nn\ne\nd\n2";

    expect(
      verify(
        null,
        Buffer.from(payload),
        b.publicKey,
        Buffer.from(signProof(payload, a.encodedPrivate), "base64"),
      ),
    ).toBe(false);
  });

  it("自己検査の文字列も同じ鍵で検証できる", () => {
    // 配備時に鍵が対になっていることを確かめるためのもの。秘密鍵は動かさない。
    const { encodedPrivate, publicKey } = keypair();
    expect(
      verify(
        null,
        Buffer.from(SELFTEST_PAYLOAD),
        publicKey,
        Buffer.from(signProof(SELFTEST_PAYLOAD, encodedPrivate), "base64"),
      ),
    ).toBe(true);
  });

  it("公開鍵は秘密鍵から導ける (配備時の突き合わせに使う)", () => {
    const { encodedPrivate, publicKey } = keypair();
    const pem = Buffer.from(encodedPrivate, "base64").toString("utf8");
    const derived = createPublicKey(createPrivateKey(pem));
    expect(derived.export({ type: "spki", format: "pem" })).toBe(
      publicKey.export({ type: "spki", format: "pem" }),
    );
  });
});

describe("開けてよいかの集計", () => {
  // 6 つの数のどれかが 0 でなければ証拠は作られない。どれか 1 つでも数え落とすと、
  // 生きたトークンを残したまま「終わっている」と読める。
  type Row = Record<string, unknown>;

  function fakePrisma(rows: Row[]) {
    const queries: Row[] = [];
    const count = ({ where }: { where: Row }) => {
      queries.push(where);
      return rows.filter((row) => matches(row, where)).length;
    };
    return {
      gitAccountDeletion: { count },
      // 本物は 1 つのトランザクションで数える。数える間に状態が動くと、
      // 6 つの数が別々の時点のものになる。
      $transaction: async (calls: number[]) => calls,
      queries,
    };
  }

  function matches(row: Row, where: Row): boolean {
    for (const [key, expected] of Object.entries(where)) {
      if (key === "OR") {
        if (!(expected as Row[]).some((clause) => matches(row, clause))) {
          return false;
        }
        continue;
      }
      const actual = row[key];
      if (expected !== null && typeof expected === "object") {
        const not = (expected as { not?: unknown }).not;
        if (actual === not) return false;
        continue;
      }
      if (actual !== expected) return false;
    }
    return true;
  }

  const purgedTracked = {
    phase: "PURGED",
    forgejoUsername: "someone",
    checkedGeneration: null,
    lastAttemptAt: null,
    lastError: null,
  };

  it("この世代で確認していない墓標を remaining に数える", async () => {
    const prisma = fakePrisma([purgedTracked]);
    await expect(
      collectGitReconcileStatus(prisma, "gen-1"),
    ).resolves.toMatchObject({ remaining: 1, failed: 0 });
  });

  it("この世代で確認済みなら数えない", async () => {
    const prisma = fakePrisma([
      { ...purgedTracked, checkedGeneration: "gen-1" },
    ]);
    await expect(
      collectGitReconcileStatus(prisma, "gen-1"),
    ).resolves.toMatchObject({ remaining: 0 });
  });

  it("失敗した記録は failed にも数える", async () => {
    const prisma = fakePrisma([{ ...purgedTracked, lastError: "boom" }]);
    await expect(
      collectGitReconcileStatus(prisma, "gen-1"),
    ).resolves.toMatchObject({ remaining: 1, failed: 1 });
  });

  it("名前の無い墓標も、この世代で確認していなければ数える", async () => {
    const prisma = fakePrisma([
      { ...purgedTracked, forgejoUsername: null },
    ]);
    await expect(
      collectGitReconcileStatus(prisma, "gen-1"),
    ).resolves.toMatchObject({ unresolved: 1 });
  });

  it("名前の無い墓標も、確認済みなら数えない", async () => {
    // ここを常に数えると、Git を使わずに退会した人がいるだけで復旧が開けられない。
    const prisma = fakePrisma([
      { ...purgedTracked, forgejoUsername: null, checkedGeneration: "gen-1" },
    ]);
    await expect(
      collectGitReconcileStatus(prisma, "gen-1"),
    ).resolves.toMatchObject({ unresolved: 0 });
  });

  it("人の確認待ち・purge 待ち・退会の途中もそれぞれ数える", async () => {
    const prisma = fakePrisma([
      { phase: "NEEDS_REVIEW" },
      { phase: "READY_TO_PURGE" },
      { phase: "BLOCKING" },
    ]);
    await expect(
      collectGitReconcileStatus(prisma, "gen-1"),
    ).resolves.toMatchObject({
      needsReview: 1,
      pendingPurge: 1,
      blocking: 1,
    });
  });

  it("6 つを 1 つのトランザクションで数える", async () => {
    // 別々に数えると、数えている間に状態が動いて別の時点の数が混ざる。
    let batched = 0;
    const prisma = {
      gitAccountDeletion: { count: () => 0 },
      $transaction: async (calls: number[]) => {
        batched = calls.length;
        return calls;
      },
    };
    await collectGitReconcileStatus(prisma, "gen-1");
    expect(batched).toBe(6);
  });
});
