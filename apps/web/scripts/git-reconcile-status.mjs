// 復元の後、Forgejo 側の消し直しが終わったかを機械的に確かめる。
//
// Forgejo を戻した時点より後に退会した利用者は、その Forgejo の中で生き返って
// いる。端末に配ったトークンも一緒に戻っているので、消し直しが終わるまで git と
// LFS を通してはいけない。git-server 側からは CockroachDB に繋げないので、
// 確かめるのはここ。
//
//   pnpm run git:restore-generation --nonce '<復元時に出力された値>'   # 復元直後に 1 回
//   pnpm run git:reconcile-status                                      # 様子見
//   pnpm run git:reconcile-status --proof '<同じ値>'                   # 開けるための証拠
//
// --proof を付けると、確かめた**証拠**に署名して出力する。
//
//   - 判定は時刻ではなく**世代**で行う。復元ごとに世代を 1 つ登録し、墓標には
//     「どの世代で確認したか」を書く。時刻で比べると、VPS と Worker と DB の
//     時計のずれや、同じ秒に起きた復元前の確認を取り違える。
//   - 世代がこのデータベースに存在することが、確認した相手が本番であることの
//     裏付けになる。別の綺麗な DB を指しても、その世代が無いので通らない。
//   - 署名鍵はこちら側にしかない。git-server は公開鍵で検証するだけなので、
//     あちらの .env を読める人でも証拠は作れない。
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { createPrivateKey, sign } from "node:crypto";
import { pathToFileURL } from "node:url";

/**
 * 4 つの数を**同じ断面**で取る。別々に取ると、その間に PURGED から
 * NEEDS_REVIEW へ移った行を、remaining では移動後・needsReview では移動前として
 * 数えてしまい、どちらも 0 に見える。
 */
export async function collectGitReconcileStatus(prisma, generation) {
  const purged = { phase: "PURGED" };
  const tracked = { ...purged, forgejoUsername: { not: null } };
  // 世代を指定した場合は「その世代で確認済み」だけを確認済みとする。
  const notChecked = generation
    ? {
        OR: [
          { checkedGeneration: null },
          { checkedGeneration: { not: generation } },
        ],
      }
    : { lastAttemptAt: null };

  const [remaining, failed, needsReview, unresolved] = await prisma.$transaction(
    [
      prisma.gitAccountDeletion.count({ where: { ...tracked, ...notChecked } }),
      prisma.gitAccountDeletion.count({
        where: { ...tracked, ...notChecked, lastError: { not: null } },
      }),
      prisma.gitAccountDeletion.count({ where: { phase: "NEEDS_REVIEW" } }),
      prisma.gitAccountDeletion.count({
        where: { ...purged, forgejoUsername: null },
      }),
    ],
  );

  return { remaining, failed, needsReview, unresolved };
}

/**
 * 署名する中身。**接続先のホストを含める。**
 *
 * 世代を登録するだけなら、どの DATABASE_URL に対してもできてしまう。うっかり
 * staging を指して登録し、そこで確認して署名すると、空の結果で本番向けの証拠が
 * 作れる。実際に見た相手を署名に含め、git-server 側でも期待する相手と突き合わせる。
 */
export function proofPayload(nonce, databaseUrl) {
  return `${nonce}\n${databaseHost(databaseUrl)}`;
}

export function databaseHost(databaseUrl) {
  // postgresql://user:pass@host:port/db → host
  return new URL(databaseUrl).hostname;
}

export function signProof(payload, encodedKey) {
  // .env に PEM をそのまま置けないので base64 で持つ。
  const pem = Buffer.from(encodedKey, "base64").toString("utf8");
  return sign(null, Buffer.from(payload), createPrivateKey(pem)).toString(
    "base64",
  );
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

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });
  try {
    if (nonce) {
      const generation = await prisma.gitRestoreGeneration.findUnique({
        where: { id: nonce },
      });
      if (!generation) {
        console.error(
          `この世代はこのデータベースに登録されていません: ${nonce}\n` +
            "復元の直後に次を実行してから、定期実行を待ってください。\n" +
            `  pnpm run git:restore-generation --nonce '${nonce}'`,
        );
        process.exitCode = 1;
        return;
      }
    }

    let status;
    try {
      status = await collectGitReconcileStatus(prisma, nonce);
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

    if (nonce) console.log(`世代         ${nonce}`);
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

    const key = process.env.GIT_REOPEN_SIGNING_KEY;
    if (!key) {
      console.error(
        "\nGIT_REOPEN_SIGNING_KEY が要ります (証拠の署名に使う ed25519 秘密鍵を" +
          " base64 にしたもの)。",
      );
      process.exitCode = 1;
      return;
    }
    console.log(`接続先       ${databaseHost(connectionString)}`);
    console.log("\n消し直しは終わっています。次の値を渡して開けてください。\n");
    console.log(signProof(proofPayload(nonce, connectionString), key));
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
