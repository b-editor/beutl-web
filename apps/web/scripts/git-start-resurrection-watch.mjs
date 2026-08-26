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
