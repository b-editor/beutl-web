// v3 API 用のパッケージ読み出し (Web 版 store-utils の API 移植)。
// Web 版は next/headers ベースの contentPath/guessCurrency に依存するため、
// packages/api の Worker 版 context を使う。
import { getDb } from "@beutl/db";
import { localizedDisplayName, localizedShortDescription, selectPricing, packageTypeWhere } from "@beutl/core";
import type { PackageTypeFilter } from "@beutl/core";
import { existsUserPaymentHistory, packageTranslationSelect } from "@beutl/db";
import { contentPath } from "./content-url";
import { guessCurrency } from "./currency";

export async function packageOwned(pkgId: string, userId: string) {
  const db = await getDb();
  return !!(await db.userPackage.findFirst({
    where: {
      userId: userId,
      packageId: pkgId,
    },
  }));
}

export async function packagePaied(pkgId: string, userId: string) {
  return existsUserPaymentHistory({ userId, packageId: pkgId });
}

export type ListedPackage = {
  id: string;
  name: string;
  displayName: string | null;
  shortDescription: string;
  userName: string | null;
  userId: string;
  iconFileUrl: string | null;
  iconFileId: string | null;
  tags: string[];
  price: {
    price: number;
    currency: string;
  } | null;
};

export async function retrievePackages(
  query?: string,
  request?: Request,
  type?: PackageTypeFilter,
  pagination: { offset: number; count: number } = { offset: 0, count: 30 },
  lang?: string,
): Promise<ListedPackage[]> {
  const db = await getDb();
  const currency = await guessCurrency(request);
  const where = {
    published: true,
    audience: "USER" as const,
    ...packageTypeWhere(type),
    ...(query
      ? {
          OR: [
            { name: { contains: query } },
            { displayName: { contains: query } },
            { description: { contains: query } },
            { shortDescription: { contains: query } },
            { tags: { hasSome: [query] } },
            // 翻訳文でも引けるようにする。表示言語に限らず全言語を対象に
            // するのは、検索語の言語が表示言語と一致するとは限らないため。
            {
              PackageTranslation: {
                some: {
                  OR: [
                    { displayName: { contains: query } },
                    { shortDescription: { contains: query } },
                    { description: { contains: query } },
                  ],
                },
              },
            },
          ],
        }
      : {}),
  };

  const tmp = await db.package.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: pagination.offset,
    take: pagination.count,
    select: {
      id: true,
      displayName: true,
      name: true,
      shortDescription: true,
      tags: true,
      iconFileId: true,
      userId: true,
      user: {
        select: {
          Profile: {
            select: {
              userName: true,
            },
          },
        },
      },
      packagePricing: {
        where: currency
          ? {
              OR: [
                {
                  currency: {
                    equals: currency,
                    mode: "insensitive",
                  },
                },
                {
                  fallback: true,
                },
              ],
            }
          : {
              fallback: true,
            },
        select: {
          price: true,
          currency: true,
          fallback: true,
        },
      },
      ...(lang ? packageTranslationSelect(lang) : {}),
    },
  });

  return await Promise.all(
    tmp.map(async (pkg) => {
      const url = pkg.iconFileId && contentPath(pkg.iconFileId);

      return {
        id: pkg.id,
        name: pkg.name,
        displayName: localizedDisplayName(pkg, lang ?? "") || null,
        shortDescription: localizedShortDescription(pkg, lang ?? ""),
        userName: pkg.user.Profile?.userName || null,
        userId: pkg.userId,
        iconFileUrl: url,
        iconFileId: pkg.iconFileId,
        tags: pkg.tags,
        price: selectPricing(pkg.packagePricing, currency) || null,
      };
    }),
  );
}
