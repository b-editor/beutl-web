// 生き返りの見張りを始めた時点を記録する。**配備の最後に 1 回。**
//
//   pnpm run git:start-resurrection-watch
//
// 失効と削除の控え (GitCredentialRevocation / GitRepositoryDeletion) を書くのは
// Worker の側。3 つを配り終えるまでは、古い Worker が控えを書かずに消せる。
// マイグレーションを当てた時点を開始にすると、その隙間に消したものを見張って
// いるつもりになり、その控えを戻したときに生き返りが数に出ない。
//
// **配り終えただけでは足りない。** 配った直後は、古い isolate がまだ要求を
// 処理していることがある。そこで、
//
//   1. 新しい Worker が実際に控えを書けることを確かめる (canary)
//   2. 開始時刻は**データベースの時計**で入れる (実行ホストの時計は信用しない)
//   3. 既に始まっていれば触らない (後ろへも前へも動かさない)
//
// canary は「控えを 1 行積んで、確かめて、消す」だけ。Forgejo には触らない。
// これが通れば、新しい表 と新しいコードの両方が生きていることになる。
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { pathToFileURL } from "node:url";

/**
 * 流し切ったと明示されているか。
 *
 * **値は `quiesce-canary.sh` が出す receipt の nonce**にしてある。固定値だと
 * shell に残った古い値が別の配備をそのまま通してしまう。nonce には窓の終わりの
 * 時刻が入っているので、古すぎる申告もここで落とせる。
 *
 * **一度きりの消費までは強制していない。** 同じ nonce を 2 回渡せば 2 回とも
 * 通る。実害の入口は見張りの開始だけで、そこは `startedAt` が一度しか書かれない
 * ので二重には始まらないが、**申告そのものを使い捨てにするには、消費済みの
 * nonce を残す場所が要る** (この分岐には無い。docs の制限に挙げてある)。
 */
const DRAIN_MAX_AGE_MS = 2 * 60 * 60 * 1000;
function drainDeclared() {
  const raw = process.env.BEUTL_GIT_DRAINED;
  if (!raw) return false;
  // receipt の nonce は "<epoch 秒>:<16 進>"。時刻だけの値も受ける。
  const match = /^(\d+):[0-9a-f]{8,}$/.exec(raw);
  const at = match ? new Date(Number(match[1]) * 1000) : new Date(raw);
  if (Number.isNaN(at.getTime())) {
    console.error(
      `error: BEUTL_GIT_DRAINED を読めません: ${raw}\n` +
        "       quiesce-canary.sh が成功したときに出す行をそのまま使ってください。",
    );
    return false;
  }
  const ageMs = Date.now() - at.getTime();
  if (ageMs < -60 * 1000) {
    console.error(`error: BEUTL_GIT_DRAINED が未来の時刻です: ${raw}`);
    return false;
  }
  if (ageMs > DRAIN_MAX_AGE_MS) {
    console.error(
      `error: BEUTL_GIT_DRAINED が古すぎます (${Math.round(ageMs / 60000)} 分前)。\n` +
        "       流し切ってから配るまでの間に、口が開いていた可能性があります。\n" +
        "       quiesce-canary.sh をやり直してください。",
    );
    return false;
  }
  return true;
}

/**
 * 既に Git を提供している版から上げていないか。
 *
 * 見張りを始める瞬間、**古い Worker が処理中の消去はまだ残っている**。控えを
 * 書かない古いコードがそれを完了させると、見張りの開始より後の消去なのに控えが
 * 無い、という行き違いが残る。その後に取った控えから戻すと、生き返っても数に
 * 出ない。防ぐには、破壊的な口を閉じてから流し切るしかない。
 *
 * **その手順が済んだかどうかは、ここからは見えない。** 口を閉じるのは git-server
 * 側の Caddy と画面の側で、流し切ったことを確かめるのも向こうのホスト
 * (`quiesce-canary.sh`)。見えないものを済んだことにはしないので、**利用者が
 * いるなら、手順を通したと明示させる**。
 *
 * **時刻では判定しない。**
 *
 * 以前はここで「この配備が始まった時刻より前の行」を数えていた。境界は実行ホスト
 * の時計、`createdAt` はデータベースの時計で付くので、**ずれた分だけ判定が入れ替わる**。
 * ホストが遅れていれば配備前からの利用者を「配備後」と読んで素通しし、進んで
 * いれば今回の smoke の行を既存利用者と読んで初回配備を止める。やり直すたびに
 * 境界が変わるので、前回の smoke の行が「古い利用者」に化ける。しかも
 * 「境界より後」は smoke だけでなく、**配備の最中に現れた本物の利用者まで**
 * 除外してしまう。
 *
 * 除くのは**この smoke test が作ったアカウント 1 つだけ**にした。release は
 * `BEUTL_SMOKE_JWT` の持ち主を知っているので、その `userId` を渡す。時計は
 * どこにも出てこないので、ずれても、やり直しても、同じ答えになる。
 *
 * 初回の配備では 0 件になるので黙って通る。
 */
export async function requireDrain(prisma) {
  // smoke test の持ち主。release が渡す。**この 1 人だけを除く。**
  const smokeUserId = process.env.BEUTL_GIT_SMOKE_USER_ID || null;
  const where = smokeUserId ? { userId: { not: smokeUserId } } : {};

  // 表そのものが無ければ、Git を提供したことが無い = 初回配備。
  let accounts = 0;
  let credentials = 0;
  try {
    [accounts, credentials] = await Promise.all([
      prisma.gitAccount.count({ where }),
      prisma.gitCredential.count({ where }),
    ]);
  } catch (error) {
    if (isMissingTable(error)) return;
    throw error;
  }
  if (accounts === 0 && credentials === 0) return;
  if (drainDeclared()) return;
  console.error(
    `error: Git を使っている利用者がいます ` +
      `(アカウント ${accounts} 件 / 資格情報 ${credentials} 件` +
      `${smokeUserId ? "、smoke の分は除く" : ""})。\n` +
      "       見張りを始める前に、古い Worker が処理中の消去を流し切って\n" +
      "       ください。流し切らずに始めると、控えの無い消去が見張りの開始より\n" +
      "       後に紛れ込み、**その後の控えから戻しても生き返りが数に出ません**。\n" +
      "\n" +
      "         1. 画面と API から、リポジトリの削除と資格情報の失効を止める\n" +
      "         2. git-server で ./scripts/quiesce-canary.sh\n" +
      "         3. その出力が示す行で release を実行する\n" +
      "              BEUTL_GIT_DRAINED=<receipt の nonce> pnpm run release\n" +
      "         4. 口を開け直す前に、もう一度 quiesce-canary.sh --against <receipt>\n" +
      "\n" +
      "       手順の全文は git-server/docs/operations.md\n" +
      "       「Git の口を既に公開している版から上げるとき」。",
  );
  // **止める。** 見張りを始めてしまうと後から動かせない (前へも後ろへも動かさない
  // 作りなので、間違って始めた開始時刻はそのまま残る)。
  throw new Error(
    "refusing to start the resurrection watch: drain the destructive routes " +
      "first (see git-server/docs/operations.md), then set BEUTL_GIT_DRAINED",
  );
}

/** 表がまだ無い (= Git を一度も提供していない)。 */
function isMissingTable(error) {
  const code = error?.code ?? error?.cause?.code;
  if (code === "P2021") return true;
  const original = error?.meta?.originalCode ?? error?.cause?.meta?.originalCode;
  return original === "42P01";
}

/**
 * 控えを書ける状態かを確かめる。
 *
 * 書けないまま見張りを始めると、「見張っている」と言いながら 1 件も控えない
 * 期間ができる。その期間の控えから戻すと、生き返りが数に出ない。
 */
async function canary(prisma) {
  const marker = `canary:${Math.random().toString(36).slice(2)}`;
  const row = await prisma.gitRepositoryDeletion.create({
    data: {
      intentId: marker,
      // 実在しない id。Forgejo には触らないので衝突しても影響しない。
      forgejoRepoId: -1,
      ownerUsername: marker,
      name: marker,
      // **確かめた印は付けない。** 付けると消し直しの対象になる。
      baseline: true,
    },
  });
  const readBack = await prisma.gitRepositoryDeletion.findUnique({
    where: { id: row.id },
  });
  await prisma.gitRepositoryDeletion.delete({ where: { id: row.id } });
  if (!readBack || readBack.intentId !== marker) {
    throw new Error("could not write and read back a deletion tombstone");
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  // **配備の前に、始められるかどうかだけを見る。** release はこれを最初に呼ぶ。
  // 断るなら migration を当てる前・Worker を配る前に断りたい。
  const checkOnly = process.argv.includes("--check-only");
  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });
  try {
    const existing = await prisma.gitResurrectionWatch
      .findUnique({ where: { id: "singleton" } })
      // 表がまだ無い = 初回配備。始めるのはこの後。
      .catch((error) => {
        if (isMissingTable(error)) return null;
        throw error;
      });
    if (existing?.startedAt) {
      console.log(
        `見張りは ${existing.startedAt.toISOString()} から始まっています。` +
          "触りません。",
      );
      // **既に始まっている環境は、この検査では直せない。**
      //
      // 開始時刻は前へも後ろへも動かさない。流し切らずに始めてしまった環境が
      // あったとしても、ここで気付くことも直すこともできない。**いつ始まったかを
      // 必ず出す**ので、その時刻と配備の記録を突き合わせて人が確かめること
      // (docs/adr/0003-git-service-architecture.md「既に始まっている見張り」)。
      return;
    }

    await requireDrain(prisma);
    if (checkOnly) {
      console.log("見張りを始められます (この実行では始めません)。");
      return;
    }
    await canary(prisma);

    // **時刻はデータベースに入れさせる。** 実行ホストの時計がずれていると、
    // 見張っていない期間を見張ったことにできてしまう。控えの時刻も同じ時計で
    // 付くので、比べる相手と揃う。
    //
    // 既に入っていれば書き換えない (WHERE で条件付ける)。
    const [updated] = await prisma.$transaction([
      prisma.$executeRaw`
        UPSERT INTO "GitResurrectionWatch" ("id", "startedAt")
        SELECT 'singleton', now()
        WHERE NOT EXISTS (
          SELECT 1 FROM "GitResurrectionWatch"
          WHERE "id" = 'singleton' AND "startedAt" IS NOT NULL
        )
      `,
    ]);
    void updated;

    const after = await prisma.gitResurrectionWatch.findUnique({
      where: { id: "singleton" },
    });
    if (!after?.startedAt) {
      throw new Error("could not record the start of the resurrection watch");
    }
    console.log(`見張りを ${after.startedAt.toISOString()} から始めました。`);
    console.log(
      "これより前に取った控えからの復元では、証拠を出せません " +
        "(その時点より前の失効と削除には控えが無いため)。",
    );
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
