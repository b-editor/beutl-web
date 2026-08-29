// 復元の世代を登録する。**復元の直後に 1 回だけ**実行する。
//
//   pnpm run git:restore-generation --nonce '<復元時に出力された値>' \
//     --backup-at '<戻した控えの時点>' \
//     --db-digest '<DB の指紋>' --data-digest '<tar の指紋>'
//
// **4 つとも要る。** restore.sh が終わりに出す案内へ、そのまま貼れる形で 4 つとも
// 入っている。1 つでも欠けると登録できない (証拠も出ない)。
//
// これを登録してからでないと、定期実行が墓標に世代を書けない。書けていない状態で
// 証拠を作ろうとしても、全件が「その世代では未確認」になるので通らない。
// 逆に言えば、登録を忘れても安全側に倒れる (開けられないだけ)。
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { pathToFileURL } from "node:url";
import { PROOF_PROTOCOL } from "./git-reconcile-status.mjs";

async function main() {
  const args = process.argv.slice(2);
  const index = args.indexOf("--nonce");
  const nonce = index === -1 ? null : args[index + 1];
  const stampIndex = args.indexOf("--backup-at");
  const stampRaw = stampIndex === -1 ? null : args[stampIndex + 1];
  if (!nonce) {
    console.error(
      "usage: --nonce <復元時に出力された値> --backup-at <戻した控えの時点>\n" +
        "       --db-digest <64 桁の 16 進> --data-digest <64 桁の 16 進>\n" +
        "       4 つとも要ります (restore.sh の案内にそのまま貼れる形で出ます)。",
    );
    process.exitCode = 2;
    return;
  }
  // **戻した控えの時点。** 生き返りの見張りを始める前に取った控えには、控えの
  // 無い消去が入っている。それを戻した場合は証拠を出さない。
  //
  // **UTC で受け取る。** 時間帯の付いていない文字列は、実行するホストの設定で
  // 別の時刻になる (同じ "2026-08-26T04:30:00" が UTC と Asia/Tokyo で 9 時間
  // ずれる)。restore.sh は Z 付きで出す。
  let backupAt = null;
  if (stampRaw) {
    if (!/Z$|[+-]\d{2}:?\d{2}$/.test(stampRaw)) {
      console.error(
        `--backup-at に時間帯がありません: ${stampRaw}\n` +
          "末尾が Z か +09:00 のような形になっている必要があります " +
          "(restore.sh が出力した値をそのまま渡してください)。",
      );
      process.exitCode = 2;
      return;
    }
    backupAt = new Date(stampRaw);
    if (Number.isNaN(backupAt.getTime())) {
      console.error(
        `--backup-at を日時として読めません: ${stampRaw}\n` +
          "restore.sh が出力した値 (ISO 8601) をそのまま渡してください。",
      );
      process.exitCode = 2;
      return;
    }
  }
  // 戻した 2 つの控えの中身の指紋。**名前ではなく中身で縛る。** 名前だけだと、
  // 古い控えを新しい名前へ付け替えるだけで通る。
  const digest = (flag) => {
    const i = args.indexOf(flag);
    return i === -1 ? null : (args[i + 1] ?? null);
  };
  const dbDigest = digest("--db-digest");
  const dataDigest = digest("--data-digest");
  // **指紋は必須。** 無くても登録できると、証拠を出す側で弾くまで気付けない。
  // 形も見る (64 桁の 16 進)。
  const hex = /^[0-9a-f]{64}$/;
  for (const [flag, value] of [
    ["--db-digest", dbDigest],
    ["--data-digest", dataDigest],
  ]) {
    if (!value || !hex.test(value)) {
      console.error(
        `${flag} が要ります (64 桁の 16 進)。restore.sh が出力した値を` +
          "そのまま渡してください。\n" +
          "名前も時点も後から変えられるので、戻した控えは**中身**で縛ります。",
      );
      process.exitCode = 2;
      return;
    }
  }
  if (!backupAt) {
    console.error(
      "--backup-at が要ります。restore.sh が出力した値をそのまま渡してください。",
    );
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
    // **未来の時点は受け取らない。** 受け取ると、見張りの開始より後だと言い張れる。
    //
    // **比べる相手はデータベースの時計。** 見張りの開始も刈った線も、この時計で
    // 付いている。実行するホストの時計と比べると、そちらが進んでいるだけで
    // 境界の前の控えを後のものとして通せる。
    const [{ now: dbNow }] = await prisma.$queryRaw`SELECT now() AS now`;
    const skewMs = backupAt.getTime() - dbNow.getTime();
    if (skewMs > 60 * 1000) {
      console.error(
        `--backup-at がデータベースの時計より先です ` +
          `(${Math.round(skewMs / 1000)} 秒)。\n` +
          `  控えの時点: ${backupAt.toISOString()}\n` +
          `  データベース: ${dbNow.toISOString()}\n` +
          "控えを取ったホストの時計がずれています。NTP を確かめてください " +
          "(このずれは、開けてよいかの判定をそのまま狂わせます)。",
      );
      process.exitCode = 1;
      return;
    }

    // **一度登録した世代の中身は書き換えない。** 後から時点だけ差し替えられると、
    // 古い控えから戻した世代を「新しい控えから戻した」ことにできる。
    const existing = await prisma.gitRestoreGeneration.findUnique({
      where: { id: nonce },
    });
    if (existing) {
      const same =
        (existing.backupAt?.getTime() ?? null) ===
          (backupAt?.getTime() ?? null) &&
        (existing.dbDigest ?? null) === dbDigest &&
        (existing.dataDigest ?? null) === dataDigest;
      if (!same && (existing.backupAt || existing.dbDigest)) {
        console.error(
          `世代 ${nonce} は既に別の内容で登録されています。書き換えません。\n` +
            `  登録済み: ${existing.backupAt?.toISOString() ?? "時点なし"} ` +
            `${existing.dbDigest ?? ""}\n` +
            "別の復元なら、その復元が出した値 (nonce) を使ってください。",
        );
        process.exitCode = 1;
        return;
      }
    }
    await prisma.gitRestoreGeneration.upsert({
      where: { id: nonce },
      create: {
        id: nonce,
        backupAt,
        dbDigest,
        dataDigest,
        protocol: PROOF_PROTOCOL,
      },
      // 時点も指紋も後から足せるが、既にあるものは上で弾いてある。
      update: {
        ...(backupAt ? { backupAt } : {}),
        ...(dbDigest ? { dbDigest } : {}),
        ...(dataDigest ? { dataDigest } : {}),
        protocol: PROOF_PROTOCOL,
      },
    });

    console.log(`世代 ${nonce} を登録しました (${new URL(connectionString).hostname})。`);
    console.log(
      "**この接続先が本番であることを確かめてください。** 証拠にはこの相手が" +
        "含まれ、git-server 側でも突き合わせます。",
    );
    console.log(
      "定期実行 (15 分ごと) が一巡したら、次で証拠を作ってください。\n" +
        `  pnpm run git:reconcile-status --proof '${nonce}'`,
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
