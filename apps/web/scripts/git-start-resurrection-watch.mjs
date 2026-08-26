// 生き返りの見張りを始めた時点を記録する。**配備の最後に 1 回。**
//
//   pnpm run git:start-resurrection-watch
//
// 失効と削除の控え (GitCredentialRevocation / GitRepositoryDeletion) を書くのは
// Worker の側。3 つを配り終えるまでは、古い Worker が控えを書かずに消せる。
// マイグレーションを当てた時点を開始にすると、その隙間に消したものを見張って
// いるつもりになり、その控えを戻したときに生き返りが数に出ない。
//
// **一度書いたら進めない。** 後ろへ動かすと、見張っていた期間を無かったことに
// できてしまう。前へ動かすのも同じ (見張っていない期間を見張ったことにする)。
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { pathToFileURL } from "node:url";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });
  try {
    const existing = await prisma.gitResurrectionWatch.findUnique({
      where: { id: "singleton" },
    });
    if (existing?.startedAt) {
      console.log(
        `見張りは ${existing.startedAt.toISOString()} から始まっています。` +
          "触りません。",
      );
      return;
    }
    const startedAt = new Date();
    await prisma.gitResurrectionWatch.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", startedAt },
      update: { startedAt },
    });
    console.log(`見張りを ${startedAt.toISOString()} から始めました。`);
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
