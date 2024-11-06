import "server-only";
import { s3 } from "@/lib/storage";
import { prisma } from "@/prisma";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

type ListedPackage = {
  id: string;
  name: string;
  displayName?: string;
  shortDescription: string;
  userName?: string;
  iconFileUrl?: string;
  tags: string[];
};

export async function retrievePackages(userId: string): Promise<ListedPackage[]> {
  const tmp = (await prisma.userPackage.findMany({
    where: {
      userId: userId,
      package: {
        published: true,
      }
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
        }
      }
    }
  }));

  return Promise.all(tmp.map((up) => up.package).map(async (pkg) => {
    const url = pkg.iconFile && `/api/contents/${pkg.iconFile.id}`;

    return {
      id: pkg.id,
      name: pkg.name,
      displayName: pkg.displayName || undefined,
      shortDescription: pkg.shortDescription,
      userName: pkg.user.Profile?.userName || undefined,
      iconFileUrl: url || undefined,
      tags: pkg.tags,
    }
  }));
}