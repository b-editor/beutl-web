import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

// 詳細画面に並べるリリースの上限。打ち切りを判定できるよう 1 件多く取得する。
export const ADMIN_PACKAGE_RELEASE_LIMIT = 100;

// 管理画面のパッケージ一覧。公開状態で絞り込み、パッケージ名・表示名・所有者の
// メールアドレスで検索する。
export async function listPackagesForAdmin({
  query,
  published,
  ownerId,
  page,
  pageSize,
  prisma,
}: {
  query?: string;
  published?: boolean;
  ownerId?: string;
  page: number;
  pageSize: number;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const mode = "insensitive" as const;
  const where = {
    published,
    userId: ownerId,
    ...(query && query.length > 0
      ? {
          OR: [
            { name: { contains: query, mode } },
            { displayName: { contains: query, mode } },
            { user: { email: { contains: query, mode } } },
          ],
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    db.package.findMany({
      where,
      select: {
        id: true,
        name: true,
        displayName: true,
        published: true,
        createdAt: true,
        updatedAt: true,
        user: { select: { id: true, name: true, email: true } },
        _count: { select: { Release: true, UserPackage: true } },
      },
      // createdAt だけではページ境界で同時刻の行が重複・欠落するため id で確定させる。
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.package.count({ where }),
  ]);
  return { items, total };
}

export async function getPackageDetailForAdmin({
  packageId,
  prisma,
}: {
  packageId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return db.package.findUnique({
    where: { id: packageId },
    select: {
      id: true,
      name: true,
      displayName: true,
      shortDescription: true,
      description: true,
      webSite: true,
      tags: true,
      published: true,
      interval: true,
      createdAt: true,
      updatedAt: true,
      user: { select: { id: true, name: true, email: true } },
      packagePricing: {
        select: { id: true, currency: true, price: true, fallback: true },
        orderBy: { currency: "asc" },
      },
      Release: {
        select: {
          id: true,
          version: true,
          targetVersion: true,
          title: true,
          published: true,
          createdAt: true,
          file: { select: { name: true, size: true } },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: ADMIN_PACKAGE_RELEASE_LIMIT + 1,
      },
      _count: { select: { UserPackage: true, Release: true } },
    },
  });
}

// 公開状態を目的の値へ揃える。changed は実際に書き換えたかどうかで、既にその状態
// だった場合に監査ログへ「変更した」と残さないために使う。行が無ければ null。
export async function setPackagePublishedByAdmin({
  packageId,
  published,
  prisma,
}: {
  packageId: string;
  published: boolean;
  prisma?: PrismaTransaction;
}): Promise<{ name: string; changed: boolean } | null> {
  const db = prisma ?? await getDb();
  const updated = await db.package.updateMany({
    where: { id: packageId, published: !published },
    data: { published },
  });
  const pkg = await db.package.findUnique({
    where: { id: packageId },
    select: { name: true },
  });
  return pkg ? { name: pkg.name, changed: updated.count === 1 } : null;
}

export async function setReleasePublishedByAdmin({
  releaseId,
  published,
  prisma,
}: {
  releaseId: string;
  published: boolean;
  prisma?: PrismaTransaction;
}): Promise<{ packageId: string; version: string; changed: boolean } | null> {
  const db = prisma ?? await getDb();
  const updated = await db.release.updateMany({
    where: { id: releaseId, published: !published },
    data: { published },
  });
  const release = await db.release.findUnique({
    where: { id: releaseId },
    select: { packageId: true, version: true },
  });
  return release ? { ...release, changed: updated.count === 1 } : null;
}
