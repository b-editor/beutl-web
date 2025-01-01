import "server-only";
import { prisma } from "@/prisma";
import { guessCurrency } from "./currency";
import { existsUserPaymentHistory } from "./db/user-payment-history";

export async function packageOwned(pkgId: string, userId: string) {
  return !!await prisma.userPackage.findFirst({
    where: {
      userId: userId,
      packageId: pkgId
    }
  });
}

export async function packagePaied(pkgId: string, userId: string) {
  return existsUserPaymentHistory({ userId, packageId: pkgId });
}

export async function retrievePrices(pkgId: string) {
  return await prisma.packagePricing.findMany({
    where: {
      packageId: pkgId
    },
    select: {
      currency: true,
      price: true,
      fallback: true
    }
  });
}

export type Package = NonNullable<Awaited<ReturnType<typeof retrievePackage>>>;

export async function retrievePackage(name: string) {
  const pkg = await prisma.package.findFirst({
    where: {
      name: {
        equals: name,
        mode: "insensitive"
      },
      published: true
    },
    select: {
      id: true,
      name: true,
      displayName: true,
      description: true,
      shortDescription: true,
      published: true,
      webSite: true,
      tags: true,
      user: {
        select: {
          Profile: {
            select: {
              userName: true,
            }
          }
        }
      },
      iconFile: {
        select: {
          id: true,
          objectKey: true,
        }
      },
      PackageScreenshot: {
        select: {
          order: true,
          file: {
            select: {
              id: true,
              objectKey: true,
            }
          }
        },
        orderBy: {
          order: "asc"
        }
      },
      Release: {
        select: {
          version: true,
          title: true,
          description: true,
          targetVersion: true,
          id: true,
        },
        where: {
          published: true
        }
      }
    }
  });
  if (!pkg) {
    return null;
  }

  const screenshots = await Promise.all(pkg.PackageScreenshot.map(async (item) => {
    return {
      ...item,
      url: `/api/contents/${item.file.id}`
    }
  }));

  return {
    ...pkg,
    iconFileUrl: pkg.iconFile && `/api/contents/${pkg.iconFile.id}`,
    PackageScreenshot: screenshots
  }
}

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
  }
};

export async function retrievePackages(query?: string): Promise<ListedPackage[]> {
  const currency = await guessCurrency();

  if (query) {
    const tmp = await prisma.package.findMany({
      where: {
        published: true,
        OR: [
          {
            name: {
              contains: query,
            },
          },
          {
            displayName: {
              contains: query,
            },
          },
          {
            description: {
              contains: query,
            },
          },
          {
            shortDescription: {
              contains: query,
            },
          },
          {
            tags: {
              hasSome: [query],
            },
          },
        ],
      },
      orderBy: {
        createdAt: "desc",
      },
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
                  mode: "insensitive"
                }
              },
              {
                fallback: true
              }
            ]
          },
          select: {
            price: true,
            currency: true,
            fallback: true
          }
        }
      },
    });

    return Promise.all(
      tmp.map(async (pkg) => {
        const url = pkg.iconFile && `/api/contents/${pkg.iconFile?.id}`;

        return {
          id: pkg.id,
          name: pkg.name,
          displayName: pkg.displayName || undefined,
          shortDescription: pkg.shortDescription,
          userName: pkg.user.Profile?.userName || undefined,
          iconFileUrl: url || undefined,
          tags: pkg.tags,
          price: pkg.packagePricing.find(p => p.currency === currency)
            || pkg.packagePricing.find(p => p.fallback) || pkg.packagePricing[0]
        };
      }),
    );
  }
  const tmp = await prisma.package.findMany({
    where: {
      published: true,
    },
    orderBy: {
      createdAt: "desc",
    },
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
                mode: "insensitive"
              }
            },
            {
              fallback: true
            }
          ]
        },
        select: {
          price: true,
          currency: true,
          fallback: true
        }
      }
    },
  });


  return Promise.all(tmp.map(async (pkg) => {
    const url = pkg.iconFile && `/api/contents/${pkg.iconFile?.id}`;

    return {
      id: pkg.id,
      name: pkg.name,
      displayName: pkg.displayName || undefined,
      shortDescription: pkg.shortDescription,
      userName: pkg.user.Profile?.userName || undefined,
      iconFileUrl: url || undefined,
      tags: pkg.tags,
      price: pkg.packagePricing.find(p => p.currency === currency)
        || pkg.packagePricing.find(p => p.fallback) || pkg.packagePricing[0]
    }
  }));
}