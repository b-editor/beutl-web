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
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
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
/**
 * 証拠に必要なものを**同じスナップショットで**すべて読む。
 *
 * 数え上げ・世代・見張り・刈った線・世代の一覧を別々に読むと、その間に定期実行の
 * 刈り込みが入る。古い刈り線を通した後、刈った後の 0 を見て署名できてしまう。
 * 刈り込み側を原子的にするだけでは閉じない (読む側が跨いでいるため)。
 */
export async function collectGitReopenSnapshot(prisma, nonce) {
  return await prisma.$transaction(
    async (tx) => {
      const generation = nonce
        ? await tx.gitRestoreGeneration.findUnique({ where: { id: nonce } })
        : null;
      const latest = await tx.gitRestoreGeneration.findFirst({
        orderBy: { createdAt: "desc" },
      });
      const watch = await tx.gitResurrectionWatch.findUnique({
        where: { id: "singleton" },
      });
      const ids = (
        await tx.gitRestoreGeneration.findMany({ select: { id: true } })
      ).map((row) => row.id);
      const status = await collectGitReconcileStatus(tx, nonce ?? latest?.id);
      return { generation, latest: latest?.id ?? null, watch, ids, status };
    },
    { isolationLevel: "Serializable" },
  );
}

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
    inflightReservations,
    inflightRepairs,
    repairsNeedReview,
    unverifiedBaseline,
    unverifiedBaselineRepos,
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
      // **決着していない予約。** 曖昧に終わった改名や削除がここに残る。
      // 残っている間は「Forgejo 側がどうなったか分からない」ということなので、
      // 開けてよいとは言えない。放っておけば 30 分ほどで片が付く。
      prisma.gitRepositoryCreation.count(),
      // **渡し切れていない預かりものと、直せていないリポジトリ。**
      prisma.gitRepositoryRepair.count({ where: { needsReview: false } }),
      prisma.gitRepositoryRepair.count({ where: { needsReview: true } }),
      // **仕組みが入る前に積まれた控え。** 消えたかどうかが分からないので、
      // 人が Forgejo 側を確かめるまで開けない (世代とは関係なく数える)。
      prisma.gitCredentialRevocation.count({ where: { baseline: true } }),
      prisma.gitRepositoryDeletion.count({ where: { baseline: true } }),
    ]);

  // **入れ替え前の表に残っている控え。** 定期実行が新しい表へ移すまで、その行は
  // どの数にも出ない。移し切れていないまま署名すると、消したのに控えの無い
  // リポジトリを見落とす。表そのものが無い環境 (先に作り直した版を当てていた
  // 場合) では 0。
  let legacyPending = 0;
  try {
    legacyPending = await prisma.gitRepositoryDeletionPending.count();
  } catch (error) {
    if (error?.code !== "P2021" && error?.code !== "P2010") throw error;
  }

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
    inflightReservations,
    inflightRepairs,
    repairsNeedReview,
    // 2 つ足して 1 つの数として出す。どちらも「人が確かめるまで開けない」。
    unverifiedBaseline: unverifiedBaseline + unverifiedBaselineRepos,
    legacyPending,
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
 * v1 -> v2: 失効させたトークンと消したリポジトリの控えを数に加えた。
 * v2 -> v3: 見張りの開始・戻した控えの時点・決着していない予約と直しを条件に
 *   加え、これまでに登録した復元世代の指紋を署名の中身へ入れた。**配っていない。**
 * v3 -> v4: 戻した控えそのものの指紋 (DB dump と tar) を署名の中身へ入れた。
 *   これで、証拠が「どの控えから戻したか」まで示す。git-server 側は自分が実際に
 *   戻したファイルの指紋と突き合わせるので、別の控えで作った証拠は通らない。
 *
 * **版を上げたのに中身が同じだと意味が無い。** 古い署名側は新しい条件を見ないまま
 * 同じ行に署名でき、受け取る側には見分けが付かない。条件を増やすときは版の文字列と
 * **中身の形の両方**を変える。v4 は 8 行。
 *
 * 古い版は**受け取ってはいけない**。git-server 側も v4 だけを受ける。両側を同時に
 * 配ること (片方だけだと復旧が開けられなくなる)。
 */
export const PROOF_PROTOCOL = "beutl-reopen-v4";

export function proofPayload({
  nonce,
  environment,
  database,
  expiresAt,
  generations,
  dbDigest,
  dataDigest,
}) {
  return [
    PROOF_PROTOCOL,
    nonce,
    environment,
    database,
    String(expiresAt),
    generations,
    dbDigest,
    dataDigest,
  ].join("\n");
}

/**
 * これまでに登録した復元世代の指紋。
 *
 * **接続先の名前だけでは、同じ相手が巻き戻されたことを見分けられない。**
 * host:port/database は復元しても変わらない。git-server は自分が出した値を
 * すべて覚えているので、その一覧から同じ指紋を作って突き合わせれば、片方でも
 * 欠けている (= DB が過去へ戻っている) ことが分かる。
 */
export function generationsDigest(ids) {
  const joined = [...ids].sort().join("\n");
  return createHash("sha256").update(joined, "utf8").digest("hex");
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

/** 今の復元世代。まだ一度も復元していなければ null。 */
async function currentGeneration(prisma) {
  const latest = await prisma.gitRestoreGeneration.findFirst({
    orderBy: { createdAt: "desc" },
  });
  return latest?.id ?? null;
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

  // 登録済みの復元の値を並べる。git-server 側の一覧と突き合わせるため。
  if (args.includes("--list-generations")) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required");
    const adapter = new PrismaPg({ connectionString });
    const prisma = new PrismaClient({ adapter });
    try {
      const rows = await prisma.gitRestoreGeneration.findMany({
        orderBy: { createdAt: "asc" },
      });
      for (const row of rows) {
        console.log(
          `${row.id}\t${row.createdAt.toISOString()}\t${row.protocol ?? "-"}`,
        );
      }
      console.log(
        `\n${rows.length} 件。git-server の restore-generations にある` +
          " registered の行と、過不足なく一致している必要があります。",
      );
    } finally {
      await prisma.$disconnect();
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
    // **必要なものを 1 つのスナップショットで読む。** 別々に読むと、その間に
    // 定期実行の刈り込みが入り、古い刈り線を通した後で刈った後の 0 を見て
    // 署名できてしまう。
    let snapshot;
    try {
      snapshot = await collectGitReopenSnapshot(prisma, nonce);
    } catch (error) {
      if (error?.code === "P2021") {
        console.error(
          "必要な表がありません (GitAccountDeletion / GitCredentialRevocation " +
            "/ GitRepositoryDeletionRecord / GitResurrectionWatch)。" +
            "マイグレーションが当たっていないデータベースです " +
            "(pnpm run migrate:status で確認してください)。",
        );
        process.exitCode = 1;
        return;
      }
      throw error;
    }
    const status = snapshot.status;

    if (nonce) {
      const generation = snapshot.generation;
      if (!generation) {
        console.error(
          `この世代はこのデータベースに登録されていません: ${nonce}\n` +
            "復元の直後に、restore.sh が出した値をそのまま渡して登録してください。",
        );
        process.exitCode = 1;
        return;
      }

      const watch = snapshot.watch;
      if (!watch?.startedAt) {
        console.error(
          "生き返りの見張りがまだ始まっていません。\n" +
            "3 つの Worker を配り、smoke test が通ると `pnpm run release` が\n" +
            "記録します。配備の途中では証拠を出せません (古い Worker が控えを\n" +
            "書かずに消したものを、見張っているつもりになるため)。",
        );
        process.exitCode = 1;
        return;
      }
      if (!generation.backupAt) {
        console.error(
          `世代 ${nonce} に、戻した控えの時点が記録されていません。\n` +
            "見張りを始めた時点より前の控えかどうかを判断できません。",
        );
        process.exitCode = 1;
        return;
      }
      // **戻した控えの指紋が要る。** 名前も時点も後から変えられる。中身の指紋を
      // 世代へ結び付け、git-server 側が実際に戻したものと突き合わせる。
      const hex = /^[0-9a-f]{64}$/;
      if (
        !hex.test(generation.dbDigest ?? "") ||
        !hex.test(generation.dataDigest ?? "")
      ) {
        console.error(
          `世代 ${nonce} に、戻した控えの指紋が記録されていません` +
            " (64 桁の 16 進が 2 つ要ります)。\n" +
            "restore.sh が出力した --db-digest / --data-digest を付けて" +
            "登録し直してください。",
        );
        process.exitCode = 1;
        return;
      }
      if (generation.backupAt < watch.startedAt) {
        console.error(
          `戻した控え (${generation.backupAt.toISOString()}) は、生き返りの` +
            `見張りを始めた時点 (${watch.startedAt.toISOString()}) より前のものです。\n` +
            "その時点より前に失効させたトークンと消したリポジトリには控えが無いので、\n" +
            "生き返っていても数に出ません。**証拠は出せません。**",
        );
        process.exitCode = 1;
        return;
      }
      if (watch.prunedBefore && generation.backupAt < watch.prunedBefore) {
        console.error(
          `戻した控え (${generation.backupAt.toISOString()}) は、控えを刈った線` +
            ` (${watch.prunedBefore.toISOString()}) より前のものです。\n` +
            "その時点の失効と削除の控えはもう残っていないので、生き返っていても\n" +
            "数に出ません。**証拠は出せません。**\n" +
            "この幅は GIT_TOMBSTONE_TTL_DAYS で決まります。バックアップの保持より\n" +
            "長く取ってください (延ばしても、既に刈った分は戻りません)。",
        );
        process.exitCode = 1;
        return;
      }
      if (generation.protocol !== PROOF_PROTOCOL) {
        console.error(
          `世代 ${nonce} は ${generation.protocol ?? "版の記録なし"} で登録されて` +
            `います。今の版は ${PROOF_PROTOCOL} です。\n` +
            "登録し直してください (判定条件が増えているため、古い版で登録した\n" +
            "世代はそのまま使えません)。",
        );
        process.exitCode = 1;
        return;
      }
    }

    const generationId = nonce ?? snapshot.latest;

    if (generationId) console.log(`${"世代".padEnd(19)} ${generationId}`);
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
    // 登録済みの世代すべて。git-server が自分の控えから同じ指紋を作って比べる。
    // **スナップショットの中で読んだものを使う** (後から読み直さない)。
    const generations = generationsDigest(snapshot.ids);
    console.log(`環境         ${environment}`);
    console.log(`接続先       ${database}`);
    console.log(
      `有効期限     ${new Date(expiresAt * 1000).toISOString()} (${PROOF_TTL_SECONDS / 60} 分)`,
    );
    console.log("\n消し直しは終わっています。次の値を渡して開けてください。\n");
    console.log(
      signProof(
        proofPayload({
          nonce,
          environment,
          database,
          expiresAt,
          generations,
          dbDigest: snapshot.generation.dbDigest,
          dataDigest: snapshot.generation.dataDigest,
        }),
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
