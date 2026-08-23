// 復元の後、Forgejo 側の消し直しが終わったかを機械的に確かめる。
//
// Forgejo を戻した時点より後に退会した利用者は、その Forgejo の中で生き返って
// いる。端末に配ったトークンも一緒に戻っているので、消し直しが終わるまで git と
// LFS を通してはいけない。git-server 側からは CockroachDB に繋げないので、
// 確かめるのはここ。
//
//   pnpm run git:reconcile-status
//   pnpm run git:reconcile-status --proof '<復元時に出力された値>'
//
// --proof を付けると、確かめた**証拠**を出力する。証拠は復元時に立てた印の値と
// FORGEJO_PROXY_SECRET から作るので、確認を飛ばして作ることはできない。印の値には
// 復元の時刻が入っているので、「その復元より後に全件を確認した」ことまで示せる。
// これが無いと、前回の確認結果が残っているだけで 0 に見える状態で開けてしまう。
//
//   remaining   その復元より後にまだ確認していない墓標
//   failed      直近が失敗として記録されているもの
//   needsReview 自動では決着できず人の判断待ちのもの
//   unresolved  相手を控えていない墓標 (照合しようがない)
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";

/**
 * @param checkedAfter これより後に確認したものだけを「確認済み」とする。
 *   省略すると、いつ確認したかは問わない。
 */
export async function collectGitReconcileStatus(prisma, checkedAfter) {
  // 照合の対象は「相手を控えてある墓標」だけ。控えの無い行は引きようがないので、
  // 対象から外すのではなく **unresolved として数える**。黙って除くと、照合できない
  // ものが残ったまま 0 に見える。
  const purged = { phase: "PURGED" };
  const tracked = { ...purged, forgejoUsername: { not: null } };
  const notChecked = checkedAfter
    ? { OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lt: checkedAfter } }] }
    : { lastAttemptAt: null };

  const [remaining, failed, needsReview, unresolved] = await Promise.all([
    prisma.gitAccountDeletion.count({ where: { ...tracked, ...notChecked } }),
    prisma.gitAccountDeletion.count({
      where: { ...tracked, ...notChecked, lastError: { not: null } },
    }),
    prisma.gitAccountDeletion.count({ where: { phase: "NEEDS_REVIEW" } }),
    prisma.gitAccountDeletion.count({
      where: { ...purged, forgejoUsername: null },
    }),
  ]);

  return { remaining, failed, needsReview, unresolved };
}

/** 印の値から「いつの復元か」を取り出す。形式は <エポック秒>:<乱数>。 */
export function parseGateNonce(nonce) {
  const match = /^(\d+):[0-9a-f]{8,}$/.exec(nonce);
  if (!match) return null;
  return new Date(Number(match[1]) * 1000);
}

export function buildProof(nonce, secret) {
  return createHmac("sha256", secret).update(nonce).digest("hex");
}

async function main() {
  const args = process.argv.slice(2);
  const proofIndex = args.indexOf("--proof");
  const nonce = proofIndex === -1 ? null : args[proofIndex + 1];
  if (proofIndex !== -1 && !nonce) {
    console.error("usage: --proof <復元時に出力された値>");
    process.exitCode = 2;
    return;
  }

  let checkedAfter;
  if (nonce) {
    checkedAfter = parseGateNonce(nonce);
    if (!checkedAfter) {
      console.error(`印の値の形式が違います: ${nonce}`);
      process.exitCode = 2;
      return;
    }
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });
  try {
    let status;
    try {
      status = await collectGitReconcileStatus(prisma, checkedAfter);
    } catch (error) {
      // 表そのものが無い = マイグレーションが当たっていない。Prisma の生の
      // 例外を出すより、何をすればよいかを言う。
      if (error?.code === "P2021") {
        console.error(
          "GitAccountDeletion が存在しません。マイグレーションが当たっていない" +
            "データベースです (pnpm run migrate:status で確認してください)。",
        );
        process.exitCode = 1;
        return;
      }
      throw error;
    }

    if (checkedAfter) {
      console.log(`基準時刻     ${checkedAfter.toISOString()} より後の確認のみ`);
    }
    for (const [key, value] of Object.entries(status)) {
      console.log(`${key.padEnd(12)} ${value}`);
    }

    const blocking = Object.entries(status).filter(([, value]) => value > 0);
    if (blocking.length > 0) {
      console.error(
        `\n開けられません。0 でないもの: ${blocking
          .map(([key, value]) => `${key}=${value}`)
          .join(", ")}`,
      );
      console.error(
        "定期実行を待つか、NEEDS_REVIEW を人が片付けてからやり直してください。",
      );
      process.exitCode = 1;
      return;
    }

    if (!nonce) {
      console.log("\n消し直しは終わっています。");
      return;
    }

    const secret = process.env.FORGEJO_PROXY_SECRET;
    if (!secret) {
      console.error("\nFORGEJO_PROXY_SECRET が要ります (証拠の作成に使います)。");
      process.exitCode = 1;
      return;
    }
    console.log("\n消し直しは終わっています。次の値を渡して開けてください。\n");
    console.log(buildProof(nonce, secret));
  } finally {
    await prisma.$disconnect();
  }
}

const entryPoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (entryPoint === import.meta.url) {
  await main();
}
