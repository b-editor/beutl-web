import "server-only";

import { getDb, sumFileSizeByUserId } from "@beutl/db";
import { getEntitlementSummary } from "@beutl/api";
import { retrievePackages } from "./library/actions";

// 概要に出すライブラリのパッケージ数。これを超える分は一覧ページで見てもらう。
export const LIBRARY_PREVIEW_COUNT = 6;

export async function retrieveDashboardOverview(userId: string) {
  // Explicitly share the request-scoped PrismaClient between the library and
  // storage reads. The entitlement summary owns its consistent transaction.
  const prisma = await getDb();
  const [libraryPackages, storageUsedBytes, entitlements] = await Promise.all([
    retrievePackages(userId, { prisma, take: LIBRARY_PREVIEW_COUNT }),
    sumFileSizeByUserId({ userId, prisma }),
    // 概要ページはストレージ・ライブラリ・AI の 3 つを並べただけの画面で、
    // どれか 1 つが読めなくても残りは出せる。AI の残高だけのために
    // ページ全体を 500 にしない。
    getEntitlementSummary(userId).catch((error) => {
      console.error("Failed to read AI entitlements for the dashboard", error);
      return null;
    }),
  ]);

  return { libraryPackages, storageUsedBytes, entitlements };
}
