// 復元の後、Forgejo 側の消し直しが終わったかを機械的に確かめる。
//
// Forgejo を戻した時点より後に退会した利用者は、その Forgejo の中で生き返って
// いる。端末に配ったトークンも一緒に戻っているので、消し直しが終わるまで git と
// LFS を通してはいけない。git-server 側からは CockroachDB に繋げないので、
// 確かめるのはここ。
//
//   pnpm run git:reconcile-status
//
// 3 つとも 0 のときだけ 0 で終わる。1 つでも残っていれば非 0。
//
//   remaining   まだ見ていない墓標 (掴んだだけでは進まないので、失敗も含む)
//   failed      直近が失敗として記録されている墓標
//   needsReview 自動では決着できず人の判断待ちのもの
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { pathToFileURL } from "node:url";

export async function collectGitReconcileStatus(prisma) {
  // 照合の対象は「相手を控えてある墓標」だけ。控えの無い行は引きようがないので
  // 数に入れない (コードの絞り込みと同じにする。ここがずれると、終わっていない
  // のに 0 に見えたり、その逆になったりする)。
  const target = { phase: "PURGED", forgejoUsername: { not: null } };

  const [remaining, failed, needsReview] = await Promise.all([
    prisma.gitAccountDeletion.count({
      where: { ...target, lastAttemptAt: null },
    }),
    prisma.gitAccountDeletion.count({
      where: { ...target, lastAttemptAt: null, lastError: { not: null } },
    }),
    prisma.gitAccountDeletion.count({ where: { phase: "NEEDS_REVIEW" } }),
  ]);

  return { remaining, failed, needsReview };
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });
  try {
    let status;
    try {
      status = await collectGitReconcileStatus(prisma);
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
    console.log("\n消し直しは終わっています。git と LFS を開けられます。");
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
