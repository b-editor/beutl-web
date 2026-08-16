import "server-only";

import { getDb, sumFileSizeByUserId } from "@beutl/db";
import { retrievePackages } from "./library/actions";

export async function retrieveDashboardOverview(userId: string) {
  // getDb() は Hyperdrive の maxUses:1 に合わせて呼ぶたび新しい接続を張るため、
  // 2 つのクエリで 1 つのクライアントを共有する。
  const prisma = await getDb();
  const [libraryPackages, storageUsedBytes] = await Promise.all([
    retrievePackages(userId, prisma),
    sumFileSizeByUserId({ userId, prisma }),
  ]);

  return { libraryPackages, storageUsedBytes };
}
