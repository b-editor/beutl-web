import "server-only";
import { prisma } from "@/prisma";
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
  const profile = prisma.profile.findFirst({
    where: {
      userName: userName,
    },
    select: {
      displayName: true,
    },
  });
  const tmp = await prisma.userPackage.findMany({
    where: {
      user: {
        Profile: {
          userName: userName,
        },
      },
      package: {
        published: true,
      },
    },
    select: {
      package: {
        select: {
          id: true,
          displayName: true,
          name: true,
          shortDescription: true,
          tags: true,
          iconFile: {
            select: {
              id: true,
            },
          },
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
            where: {
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
            },
            select: {
              price: true,
              currency: true,
              fallback: true,
            },
          },
        },
      },
    },
  });
  const items = Promise.all(
    tmp
      .map((up) => up.package)
      .map(async (pkg) => {
        const url = pkg.iconFile && `/api/contents/${pkg.iconFile.id}`;

        return {
          id: pkg.id,
          name: pkg.name,
          displayName: pkg.displayName || undefined,
          shortDescription: pkg.shortDescription,
          userName: pkg.user.Profile?.userName || undefined,
          iconFileUrl: url || undefined,
          tags: pkg.tags,
          price:
            pkg.packagePricing.find((p) => p.currency === currency) ||
            pkg.packagePricing.find((p) => p.fallback) ||
            pkg.packagePricing[0],
        };
      }),
  );

  return {
    items: await items,
    displayName: (await profile)?.displayName!,
  };
}
