"use server"

import { s3 } from "@/lib/storage";
import { prisma } from "@/prisma";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export type ListedPackage = {
  id: string;
  name: string;
  displayName?: string;
  shortDescription: string;
  userName?: string;
  iconFileUrl?: string;
  tags: string[];
};

export async function retrievePackages(query?: string): Promise<ListedPackage[]> {
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
            objectKey: true,
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
      },
    });

    return Promise.all(
      tmp.map(async (pkg) => {
        const url =
          pkg.iconFile &&
          (await getSignedUrl(
            s3,
            new GetObjectCommand({
              Bucket: process.env.S3_BUCKET as string,
              Key: pkg.iconFile.objectKey,
            }),
            { expiresIn: 3600 },
          ));

        return {
          id: pkg.id,
          name: pkg.name,
          displayName: pkg.displayName || undefined,
          shortDescription: pkg.shortDescription,
          userName: pkg.user.Profile?.userName || undefined,
          iconFileUrl: url || undefined,
          tags: pkg.tags,
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
          objectKey: true,
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
    },
  });


  return Promise.all(tmp.map(async (pkg) => {
    const url = pkg.iconFile && await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: process.env.S3_BUCKET as string, Key: pkg.iconFile.objectKey }),
      { expiresIn: 3600 },
    );

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