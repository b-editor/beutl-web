import "server-only";
import { getDbAsync } from "@/db";
import { userPackage } from "@/db/schema";
import { eq } from "drizzle-orm";
import { guessCurrency } from "@/lib/currency";

type ListedPackage = {
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
): Promise<ListedPackage[]> {
  const db = await getDbAsync();
  const currency = await guessCurrency();
  const tmp = await db.query.userPackage.findMany({
    where: eq(userPackage.userId, userId),
    with: {
      package: {
        columns: {
          id: true,
          displayName: true,
          name: true,
          shortDescription: true,
          tags: true,
          published: true,
        },
        with: {
          iconFile: {
            columns: {
              id: true,
            },
          },
          user: {
            columns: {},
            with: {
              profile: {
                columns: {
                  userName: true,
                },
              },
            },
          },
          packagePricings: {
            columns: {
              price: true,
              currency: true,
              fallback: true,
            },
          },
        },
      },
    },
  });

  return await Promise.all(
    tmp
      .filter((up) => up.package.published)
      .map((up) => up.package)
      .map(async (pkg) => {
        const url = pkg.iconFile && `/api/contents/${pkg.iconFile.id}`;
        const pricings = pkg.packagePricings;
        const matchedPrice = currency
          ? pricings.find(
              (p) => p.currency.toLowerCase() === currency.toLowerCase(),
            ) ||
            pricings.find((p) => p.fallback) ||
            pricings[0]
          : pricings.find((p) => p.fallback) || pricings[0];

        return {
          id: pkg.id,
          name: pkg.name,
          displayName: pkg.displayName || undefined,
          shortDescription: pkg.shortDescription,
          userName: pkg.user.profile?.userName || undefined,
          iconFileUrl: url || undefined,
          tags: pkg.tags ?? [],
          price: matchedPrice,
        };
      }),
  );
}
