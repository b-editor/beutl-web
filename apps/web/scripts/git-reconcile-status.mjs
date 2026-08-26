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
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { pathToFileURL } from "node:url";

/**
 * 数を**同じ断面**で取る。別々に取ると、その間に PURGED から NEEDS_REVIEW へ
 * 移った行を、remaining では移動後・needsReview では移動前として数えてしまい、
 * どちらも 0 に見える。
 *
 * 見るのは 2 種類。
 *
 *   退会 (GitAccountDeletion) — アカウントごと消えた人。
 *   個別の消去 (GitCredentialRevocation / GitRepositoryDeletion) — 生きている
 *     利用者が 1 本だけ失効させたトークンと、消したリポジトリ。**退会の数には
 *     一切現れない。** これを見ないと、端末に平文の残る失効済みトークンが復元で
 *     生き返っていても、6 つの数はすべて 0 のまま証拠が作れてしまう。
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

  // 個別の消去の控えは phase を持たない。「この世代で確認していない」の条件だけ
  // 同じものを使う。
  const notCheckedTombstone = generation
    ? {
        OR: [
          { checkedGeneration: null },
          { checkedGeneration: { not: generation } },
        ],
      }
    : { checkedGeneration: null };

  const [
    remaining,
    failed,
    needsReview,
    unresolved,
    pendingPurge,
    blocking,
    credentials,
    credentialsFailed,
    repositories,
    repositoriesFailed,
    repositoriesReview,
  ] = await prisma.$transaction([
      prisma.gitAccountDeletion.count({ where: { ...tracked, ...notChecked } }),
      prisma.gitAccountDeletion.count({
        where: { ...tracked, ...notChecked, lastError: { not: null } },
      }),
      prisma.gitAccountDeletion.count({ where: { phase: "NEEDS_REVIEW" } }),
      // **名前を控えていない墓標。** 相手の名前が分からなくても、合成メールは
      // userId から決まるので引ける。だから「確認できない」ではなく「この世代で
      // まだ確認していない」を数える。確認済みまで数えると、Git を使わずに退会した
      // 人がいるだけで復旧が開けられなくなる。
      prisma.gitAccountDeletion.count({
        where: { ...purged, forgejoUsername: null, ...notChecked },
      }),
      // **消し切れていない退会。** Forgejo 側の purge が失敗した行はここに残る。
      // 数えないと、退会したはずのアカウントと端末のトークンが生きたまま
      // 「終わっている」と読める。
      prisma.gitAccountDeletion.count({ where: { phase: "READY_TO_PURGE" } }),
      // 退会を始めたまま進んでいないもの。掃除役が拾うが、残っている間は
      // 「どうなっているか分からない」ので開けない。
      prisma.gitAccountDeletion.count({ where: { phase: "BLOCKING" } }),
      // **失効させたトークン。** 生きている利用者のものなので退会には現れない。
      // 端末には平文が残っている。復元で生き返ったまま開けると、失効したはずの
      // トークンで git と LFS が通る。
      prisma.gitCredentialRevocation.count({ where: notCheckedTombstone }),
      prisma.gitCredentialRevocation.count({
        where: { ...notCheckedTombstone, lastError: { not: null } },
      }),
      // **消したリポジトリ。** 同じく退会には現れない。
      prisma.gitRepositoryDeletion.count({
        where: { needsReview: false, ...notCheckedTombstone },
      }),
      prisma.gitRepositoryDeletion.count({
        where: {
          needsReview: false,
          ...notCheckedTombstone,
          lastError: { not: null },
        },
      }),
      // その id が別のリポジトリを指している。人が見るまで自動では決められない。
      prisma.gitRepositoryDeletion.count({ where: { needsReview: true } }),
    ]);

  return {
    remaining,
    failed,
    needsReview,
    unresolved,
    pendingPurge,
    blocking,
    credentials,
    credentialsFailed,
    repositories,
    repositoriesFailed,
    repositoriesReview,
  };
}

/**
 * 署名する中身。
 *
 * 世代を登録するだけなら、どの DATABASE_URL に対してもできてしまう。うっかり
 * staging を指して登録し、そこで確認して署名すると、空の結果で本番向けの証拠が
 * 作れる。だから**実際に見た相手**を署名に入れ、git-server 側でも突き合わせる。
 *
 * ホスト名だけでは足りない。同じホストに本番と staging が別のデータベースとして
 * 載っていることがある。port とデータベース名まで含め、さらに配備側で決めた
 * 環境の名前 (GIT_REOPEN_ENVIRONMENT) も入れる。
 *
 * 期限も入れる。証拠を作った後に状態が悪くなっても署名は変わらないので、
 * 有効な時間を短く切る。**「その時点では終わっていた」ことしか示せない**ので、
 * 作ったらすぐ使う。
 */
/**
 * 証拠の版。
 *
 * 判定に使う項目を増やしたときに、古い署名側が作った証拠を受け取らないための
 * 目印。版を上げれば、古い側の署名は検証に通らなくなる。
 *
 * v1 -> v2: 失効させたトークンと消したリポジトリの控えを数に加えた。v1 の証拠は
 * それらを見ていないので、**受け取ってはいけない**。git-server 側も v2 だけを
 * 受ける。両側を同時に配ること (片方だけだと復旧が開けられなくなる)。
 */
export const PROOF_PROTOCOL = "beutl-reopen-v2";

export function proofPayload({ nonce, environment, database, expiresAt }) {
  return [PROOF_PROTOCOL, nonce, environment, database, String(expiresAt)].join(
    "\n",
  );
}

/** host:port/database。接続先を一意に指す。 */
export function databaseIdentity(databaseUrl) {
  const url = new URL(databaseUrl);
  const database = url.pathname.replace(/^\//, "");
  return `${url.hostname}:${url.port || "26257"}/${database}`;
}

/**
 * 証拠が有効な長さ。作ってすぐ使う前提で短く切る。
 *
 * git-server 側の上限より**短く**しておく。同じ値にすると、あちらの時計が
 * わずかに遅れているだけで「期限が長すぎる」と拒まれる。
 */
export const PROOF_TTL_SECONDS = 10 * 60;

export function signProof(payload, encodedKey) {
  // .env に PEM をそのまま置けないので base64 で持つ。
  const pem = Buffer.from(encodedKey, "base64").toString("utf8");
  return sign(null, Buffer.from(payload), createPrivateKey(pem)).toString(
    "base64",
  );
}

/**
 * 鍵が対になっていることを、秘密鍵を動かさずに確かめるための固定文字列。
 * git-server 側は公開鍵でこれを検証する。
 */
export const SELFTEST_PAYLOAD = "beutl-git-reopen-selftest";

async function main() {
  const args = process.argv.slice(2);

  // 鍵の疎通確認。DB には触らない。
  if (args.includes("--selftest")) {
    const key = process.env.GIT_REOPEN_SIGNING_KEY;
    if (!key) {
      console.error("GIT_REOPEN_SIGNING_KEY が要ります。");
      process.exitCode = 1;
      return;
    }
    const pem = Buffer.from(key, "base64").toString("utf8");
    const publicKey = createPublicKey(createPrivateKey(pem))
      .export({ type: "spki", format: "pem" })
      .toString();
    console.log(
      "git-server の .env に GIT_REOPEN_SELFTEST_SIGNATURE として置いてください。\n" +
        "**署名鍵を変えたら必ず作り直すこと。** 古い署名は古い公開鍵に対して\n" +
        "通り続けるので、preflight は通るのに復旧時にだけ失敗します。\n" +
        "下の公開鍵が git-server の GIT_REOPEN_PUBLIC_KEY と同じかも見てください。\n",
    );
    console.log(signProof(SELFTEST_PAYLOAD, key));
    console.log(
      `\nGIT_REOPEN_PUBLIC_KEY=${Buffer.from(publicKey).toString("base64")}`,
    );
    // 接続先も出す。git-server の GIT_REOPEN_DATABASE と突き合わせるため。
    // 形だけ合っていても、実際に見に行く相手と違えば意味が無い。
    if (process.env.DATABASE_URL) {
      console.log(
        `GIT_REOPEN_DATABASE=${databaseIdentity(process.env.DATABASE_URL)}`,
      );
    }
    if (process.env.GIT_REOPEN_ENVIRONMENT) {
      console.log(`GIT_REOPEN_ENVIRONMENT=${process.env.GIT_REOPEN_ENVIRONMENT}`);
    }
    return;
  }

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
          "必要な表がありません (GitAccountDeletion / GitCredentialRevocation " +
            "/ GitRepositoryDeletion)。マイグレーションが当たっていない" +
            "データベースです (pnpm run migrate:status で確認してください)。",
        );
        process.exitCode = 1;
        return;
      }
      throw error;
    }

    if (nonce) console.log(`${"世代".padEnd(19)} ${nonce}`);
    for (const [key, value] of Object.entries(status)) {
      console.log(`${key.padEnd(20)} ${value}`);
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
    const environment = process.env.GIT_REOPEN_ENVIRONMENT;
    if (!environment) {
      console.error(
        "\nGIT_REOPEN_ENVIRONMENT が要ります (git-server 側の同名の値と一致させる)。",
      );
      process.exitCode = 1;
      return;
    }
    const database = databaseIdentity(connectionString);
    const expiresAt = Math.floor(Date.now() / 1000) + PROOF_TTL_SECONDS;
    console.log(`環境         ${environment}`);
    console.log(`接続先       ${database}`);
    console.log(
      `有効期限     ${new Date(expiresAt * 1000).toISOString()} (${PROOF_TTL_SECONDS / 60} 分)`,
    );
    console.log("\n消し直しは終わっています。次の値を渡して開けてください。\n");
    console.log(
      signProof(
        proofPayload({ nonce, environment, database, expiresAt }),
        key,
      ),
    );
    console.log(`\n  ./scripts/restore.sh --reopen-git --proof <上の値> --expires ${expiresAt}`);
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
