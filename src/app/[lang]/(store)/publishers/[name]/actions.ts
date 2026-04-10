import "server-only";
import { getDbAsync } from "@/db";
import { packageTable, profile } from "@/db/schema";
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

export async function retrievePublishedPackages(
  userName: string,
): Promise<{ items: ListedPackage[]; displayName: string }> {
  const currency = await guessCurrency();
  const db = await getDbAsync();
  const profileResult = db.query.profile.findFirst({
    where: eq(profile.userName, userName),
    columns: {
      displayName: true,
    },
  });

  // Fetch packages by user's profile userName
  const profileData = await db.query.profile.findFirst({
    where: eq(profile.userName, userName),
    columns: {
      userId: true,
    },
  });

  const tmp = profileData
    ? await db.query.packageTable.findMany({
        where: eq(packageTable.userId, profileData.userId),
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
      })
    : [];

  const items = Promise.all(
    tmp
      .filter((pkg) => pkg.published)
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

  return {
    items: await items,
    displayName: (await profileResult)?.displayName || userName,
  };
}
