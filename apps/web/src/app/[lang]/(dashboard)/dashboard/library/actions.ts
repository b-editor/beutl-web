import "server-only";
import { contentPath } from "@/lib/content-url";
import { guessCurrency } from "@/lib/currency";
import { retrieveLibraryPackagesByUserId, type PrismaTransaction } from "@beutl/db";
import { selectPricing } from "@beutl/core";

export type ListedPackage = {
  id: string;
  name: string;
  displayName?: string;
  shortDescription: string;
  userName?: string;
  iconFileUrl?: string;
  tags: string[];
  price?: {
    price: number;
    currency: string;
  };
};

export async function retrievePackages(
  userId: string,
  options: {
    // 概要ページは他のクエリと 1 つの接続を共有するため注入できるようにしてある。
    prisma?: PrismaTransaction;
    // 概要ページは数件しか描画しないので、DB 側で切っておく。
    take?: number;
  } = {},
): Promise<ListedPackage[]> {
  const currency = await guessCurrency();
  const tmp = await retrieveLibraryPackagesByUserId({
    userId,
    currency,
    take: options.take,
    prisma: options.prisma,
  });

  return await Promise.all(
    tmp
      .map((up) => up.package)
      .map(async (pkg) => {
        const url = pkg.iconFile && contentPath(pkg.iconFile.id);

        return {
          id: pkg.id,
          name: pkg.name,
          displayName: pkg.displayName || undefined,
          shortDescription: pkg.shortDescription,
          userName: pkg.user.Profile?.userName || undefined,
          iconFileUrl: url || undefined,
          tags: pkg.tags,
          price: selectPricing(pkg.packagePricing, currency),
        };
      }),
  );
}
