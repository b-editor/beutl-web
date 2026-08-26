// 配備の順序を固定する。
//
// マイグレーションより先に Worker を出すと、新しいテーブルや列を前提にした経路が
// 本番で落ちる。この分岐で言えば、資格情報の発行前に見る GitAccountDeletion と、
// 15 分ごとの cron がそれにあたる。だから当てるのが先。
//
// **「足すだけだから先に当てても安全」ではない。** それは大半がそうというだけで、
// 決まりではない。20260824060000_drop_legacy_rename_reservations は行を消す。
// 行を消すマイグレーションは、当てた時点で**まだ動いている古い Worker が何を
// しているか**と突き合わせて読むこと (このときは、元の名前を持たない改名の予約 —
// 決着を付けられる Worker がもう居ない行 — だった)。都度確かめる。
//
//   1. 当てる前に食い違いを見る (この分岐に無いものが本番に入っていたら止まる)
//   2. prisma migrate deploy
//   3. 適用し切れたことを確かめる (未適用が残っていたら Worker を配らない)
//   4. Worker を 3 つ配る
//   5. 認証付きの smoke test で、配った Worker が新しい schema を読めることを見る
//
// 5 には利用者の JWT が要る。BEUTL_SMOKE_JWT に入れる。持っていない場合は
// --skip-smoke を明示する (黙って飛ばすと、確かめていないものを確かめたことに
// してしまう)。
import { execFileSync, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const appRoot = resolve(import.meta.dirname, "..");
const webDir = join(appRoot, "apps", "web");
const prismaBin = join(webDir, "node_modules", ".bin", "prisma");
const schema = join(webDir, "prisma", "schema.prisma");

const args = process.argv.slice(2);
const skipSmoke = args.includes("--skip-smoke");
const dryRun = args.includes("--dry-run");
const origin = process.env.BEUTL_SMOKE_ORIGIN ?? "https://beutl.beditor.net";
const adminOrigin =
  process.env.BEUTL_SMOKE_ADMIN_ORIGIN ?? "https://admin.beutl.beditor.net";
// /api/v3/git/account は無ければ Forgejo ユーザーを作る。本番で毎回叩くと、
// smoke 用の JWT の持ち主に副作用が出る。専用アカウントを用意したときだけ有効に。
const provisionCheck = process.env.BEUTL_SMOKE_PROVISION === "1";
const unknown = args.filter(
  (arg) => !["--skip-smoke", "--dry-run"].includes(arg),
);
if (unknown.length > 0) {
  console.error(`usage: pnpm run release [--skip-smoke] [--dry-run]`);
  process.exit(2);
}

const step = (message) => console.log(`\n==> ${message}`);

function run(command, commandArgs, options = {}) {
  if (dryRun) {
    console.log(`    (dry-run) ${command} ${commandArgs.join(" ")}`);
    return "";
  }
  return execFileSync(command, commandArgs, {
    cwd: appRoot,
    encoding: "utf8",
    stdio: options.capture ? ["inherit", "pipe", "inherit"] : "inherit",
    ...options,
  });
}

/**
 * status の出力を取る (stdout と stderr の両方)。
 *
 * 判断材料は **stderr** に出る。「Your local migration history and the migrations
 * table from your database are different」も「not found locally」も stdout には
 * 出ない (prisma 7.9.1 で実測)。片方だけ見ると、見ているつもりで何も見ていない。
 * 成功時も execFileSync が返すのは stdout だけなので、spawnSync で両方取る。
 */
function migrateStatus() {
  const result = spawnSync(
    prismaBin,
    ["migrate", "status", "--schema", schema],
    { cwd: webDir, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  return {
    ok: result.status === 0,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

// 「本番に入っているのに手元に無い」= この分岐が main より古い時点から生えている。
// そのまま当てると順序が入れ替わり、以後ずっと食い違いが残る。
const DIVERGED = "not found locally";
// 履歴そのものが食い違っている。上と一緒に出ることが多いが、単独でも出る。
const DRIFT = "migration history and the migrations table from your database are different";
// **通してよい唯一の非 0**。まだ当てていないものがあるのは、これから当てるのだから当然。
const PENDING = "have not yet been applied";

step("当てる前に食い違いを見ています");
if (!dryRun) {
  const before = migrateStatus();
  process.stdout.write(before.out);
  if (before.out.includes(DIVERGED) || before.out.includes(DRIFT)) {
    console.error(
      "\nerror: 本番に入っているマイグレーションがこの分岐にありません。" +
        "\n       main に追従してから配備してください。" +
        "\n       このまま当てると順序が入れ替わり、後から直せません。" +
        "\n       データベースには何もしていません。",
    );
    process.exit(1);
  }
  // **知っている形以外は通さない。** 特定の文言だけを探していると、checksum の
  // 不一致・途中で失敗した migration・接続の失敗といった別の異常が「食い違いは
  // 無い」として素通りする。deploy 側が落ちるとしても、この検査が門である以上、
  // 門が見ていないことを見ているように見せてはいけない。
  if (!before.ok && !before.out.includes(PENDING)) {
    console.error(
      "\nerror: マイグレーションの状態を判断できませんでした (上の出力を確認して" +
        "ください)。" +
        "\n       まだ当てていないものがある、という形ではありません。" +
        "\n       データベースには何もしていません。",
    );
    process.exit(1);
  }
}

step("マイグレーションを適用しています");
run(prismaBin, ["migrate", "deploy", "--schema", schema], { cwd: webDir });

step("適用状態を確かめています");
if (!dryRun) {
  const after = migrateStatus();
  process.stdout.write(after.out);
  if (!after.ok) {
    console.error(
      "\nerror: マイグレーションが適用し切れていません。Worker は配りません。",
    );
    process.exit(1);
  }
}

step("Worker を配っています");
for (const target of ["deploy:web", "deploy:api", "deploy:admin"]) {
  run("pnpm", ["run", target]);
}



/** 確かめていないものを黙って通さない。最後に必ず出す。 */
function reportUnverified() {
  console.error(
    "\n確かめていないもの (smoke test の範囲外):\n" +
      "  - Web / Admin Worker の Forgejo 用 secret (セッションが要るため)\n" +
      "  - 管理画面からの削除経路 (リポジトリの削除・資格情報の失効)\n" +
      "  - beutl-web-api の定期実行 (cron は外から起動できない)\n" +
      "  - 失効と削除の控えが実際に書かれること\n" +
      "    ↑ ここが黙って壊れると、復元の証拠が「終わっている」と言い続ける。\n" +
      "      配備の後に 1 度、資格情報を 1 本発行して失効させ、\n" +
      "      GitCredentialRevocation に confirmed=true の行が増えることを見ること。",
  );
}

if (skipSmoke) {
  console.error(
    "\n警告: smoke test を飛ばしました。新しい schema を Worker が読めるかは" +
      "確かめていません。",
  );
  // **見張りは始めない。** 動いていることを確かめていないので、始めると
  // 「見張っている」と言いながら 1 件も控えない期間ができる。
  console.error(
    "      生き返りの見張りも始めていません。確かめたうえで手で始めてください:\n" +
      "        pnpm run git:start-resurrection-watch",
  );
  reportUnverified();
  process.exit(0);
}

step("確かめています");

if (dryRun) {
  console.log(`    (dry-run) GET ${origin}/`);
  console.log(`    (dry-run) GET ${adminOrigin}/`);
  console.log(`    (dry-run) GET ${origin}/api/v3/git/credentials (JWT)`);
  if (provisionCheck) {
    console.log(`    (dry-run) GET ${origin}/api/v3/git/account (JWT)`);
  }
  reportUnverified();
  process.exit(0);
}

/** 到達できるか。セッションが要らないので、返るのは 2xx でも 3xx でもよい。 */
async function checkReachable(url) {
  const response = await fetch(url, { redirect: "manual" });
  if (response.status >= 400) {
    console.error(`error: GET ${url} が ${response.status} を返しました`);
    return false;
  }
  console.log(`OK  GET ${url} (${response.status})`);
  return true;
}

let ok = true;
ok = (await checkReachable(`${origin}/`)) && ok;
ok = (await checkReachable(`${adminOrigin}/`)) && ok;

const jwt = process.env.BEUTL_SMOKE_JWT;
if (!jwt) {
  console.error(
    "\nerror: BEUTL_SMOKE_JWT がありません。配備自体は終わっていますが、" +
      "新しい schema を Worker が読めるかは確認できていません。\n" +
      "       利用者の JWT を入れて smoke test だけやり直すか、確かめない" +
      "ことを承知のうえで --skip-smoke を付けてください。",
  );
  reportUnverified();
  process.exit(1);
}

// この分岐で入ったテーブルを読む経路。マイグレーションが当たっていなければ
// 200 にはならない。/credentials は GitCredential を読むだけで副作用が無い。
const paths = ["/api/v3/git/credentials"];
// /account は無ければ Forgejo ユーザーを作る。専用アカウントのときだけ叩く。
if (provisionCheck) paths.push("/api/v3/git/account");

for (const path of paths) {
  const response = await fetch(`${origin}${path}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  const body = await response.text();
  if (!response.ok) {
    console.error(
      `error: GET ${path} が ${response.status} を返しました: ${body.slice(0, 300)}`,
    );
    ok = false;
    continue;
  }
  console.log(`OK  GET ${path}`);
}

if (!provisionCheck) {
  console.log(
    "    /api/v3/git/account は叩いていません (無ければ Forgejo ユーザーを" +
      "作るため)。専用の smoke アカウントを使う場合は BEUTL_SMOKE_PROVISION=1。",
  );
}

if (!ok) {
  // **確かめられていないなら見張りも始めない。** 始めると「見張っている」と
  // 言いながら 1 件も控えない期間ができ、その控えから戻したときに生き返りが
  // 数に出ない。
  reportUnverified();
  process.exit(1);
}

// **生き返りの見張りは、配って動くことを確かめてから始める。**
//
// 失効と削除の控えを書くのは Worker の側。マイグレーションを当てた時点を開始に
// すると、入れ替え終わるまでの間に古い Worker が控えを書かずに消したものを、
// 見張っているつもりになる。その控えを戻したときに、生き返りが数に出ない。
//
// 開始の時刻はデータベースの時計で入り、控えを 1 行書いて読み戻せることまで
// 確かめてから確定する (git-start-resurrection-watch.mjs)。
step("生き返りの見張りを始めています");
run("pnpm", ["run", "git:start-resurrection-watch"]);

console.log("\n配備と確認が終わりました。");
reportUnverified();
