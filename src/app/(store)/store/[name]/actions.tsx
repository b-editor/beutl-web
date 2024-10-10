"use server";

import { auth } from "@/auth";
import { prisma } from "@/prisma";

export async function handleGet(name: string) {
  const session = await auth();
  await new Promise(resolve => setTimeout(resolve, 1000));
}

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