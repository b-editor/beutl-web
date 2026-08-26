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
  // 無い消去が入っている。それを戻した場合は証拠を出さない。判断できるように、
  // ここで控えの時点を控える。
  let backupAt = null;
  if (stampRaw) {
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

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });
  try {
    await prisma.gitRestoreGeneration.upsert({
      where: { id: nonce },
      create: { id: nonce, backupAt },
      // 登録し直しても、控えの時点は後から足せるようにする。消しはしない。
      update: backupAt ? { backupAt } : {},
    });
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
