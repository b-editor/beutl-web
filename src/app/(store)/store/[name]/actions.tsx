"use server";

import { auth } from "@/auth";
import { authenticated } from "@/lib/auth-guard";
import { prisma } from "@/prisma";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function addToLibrary(packageId: string) {
  const session = await auth();
  const { name } = await prisma.package.findFirstOrThrow({
    where: {
      id: packageId,
    },
    select: {
      name: true,
    }
  });
  if (!session?.user?.id) {
    redirect(`/store/${name}/get`);
  }
  const existing = await prisma.userPackage.findFirst({
    where: {
      userId: session.user.id,
      packageId,
    }
  });
  if (!existing) {
    await prisma.userPackage.create({
      data: {
        userId: session.user.id,
        packageId,
      }
    });
  }
  revalidatePath(`/store/${name}`);
  redirect(`/store/${name}`);
}

export async function removeFromLibrary(packageId: string) {
  return await authenticated(async (session) => {
    const { package: { name } } = await prisma.userPackage.delete({
      where: {
        userId_packageId: {
          userId: session.user.id,
          packageId,
        },
      },
      select: {
        package: {
          select: {
            name: true,
          }
        }
      }
    });
    revalidatePath(`/store/${name}`);
    return {
      success: true,
      message: "ライブラリから削除しました",
    }
  });
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