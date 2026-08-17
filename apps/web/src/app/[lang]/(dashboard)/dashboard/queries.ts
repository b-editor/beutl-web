import "server-only";

import { getDb, sumFileSizeByUserId } from "@beutl/db";
import { getEntitlements } from "@beutl/api";
import { retrievePackages } from "./library/actions";

// 概要に出すライブラリのパッケージ数。これを超える分は一覧ページで見てもらう。
export const LIBRARY_PREVIEW_COUNT = 6;

export async function retrieveDashboardOverview(userId: string) {
  // getDb() は Hyperdrive の maxUses:1 に合わせて呼ぶたび新しい接続を張るため、
  // 2 つのクエリで 1 つのクライアントを共有する。
  const prisma = await getDb();
  const [libraryPackages, storageUsedBytes, entitlements] = await Promise.all([
    retrievePackages(userId, { prisma, take: LIBRARY_PREVIEW_COUNT }),
    sumFileSizeByUserId({ userId, prisma }),
    getEntitlements(userId),
  ]);

  return { libraryPackages, storageUsedBytes, entitlements };
}
