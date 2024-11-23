"use server";

import { auth } from "@/auth";
import { authenticated } from "@/lib/auth-guard";
import { prisma } from "@/prisma";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function addToLibrary(packageId: string) {
  const { name } = await prisma.package.findFirstOrThrow({
    where: {
      id: packageId,
    },
    select: {
      name: true,
    }
  });
  redirect(`/store/${name}/get`);
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
