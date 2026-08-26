// 復元の世代を登録する。**復元の直後に 1 回だけ**実行する。
//
//   pnpm run git:restore-generation --nonce '<復元時に出力された値>'
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
      "usage: --nonce <復元時に出力された値> --backup-at <戻した控えの時点>",
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
    // **未来の時点は受け取らない。** 受け取ると、見張りの開始より後だと言い張れる。
    if (backupAt.getTime() > Date.now() + 5 * 60 * 1000) {
      console.error(
        `--backup-at が未来です: ${backupAt.toISOString()}\n` +
          "戻した控えの時点として受け取れません。",
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

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });
  try {
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
    if (!dbDigest || !dataDigest) {
      console.warn(
        "\n警告: --db-digest / --data-digest を渡していません。戻した控えを" +
          "\n      名前でしか identify できず、古い控えを新しい名前へ付け替えた" +
          "\n      場合を見分けられません。restore.sh が出力した値を付けてください。",
      );
    }
    if (!backupAt) {
      console.warn(
        "\n警告: --backup-at を渡していません。戻した控えが、生き返りの見張りを" +
          "\n      始めるより前のものかどうかを判断できないため、証拠は出せません。" +
          "\n      restore.sh が出力した時点を付けて、もう一度実行してください。",
      );
    }
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
