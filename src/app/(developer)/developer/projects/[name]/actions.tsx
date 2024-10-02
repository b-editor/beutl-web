"use server";

import { auth } from "@/auth";
import { prisma } from "@/prisma";
import { revalidatePath } from "next/cache";
import { z } from "zod";

export type State = {
  errors?: {
    displayName?: string[];
    shortDescription?: string[];
  };
  success?: boolean;
  message?: string | null;
};

const displayNameAndShortDescriptionSchema = z.object({
  displayName: z.string().max(50, "表示名は50文字以下である必要があります"),
  shortDescription: z.string().max(200, "短い説明は200文字以下である必要があります"),
  id: z.string().uuid("IDが不正です"),
});

export async function updateDisplayNameAndShortDescription(state: State, formData: FormData): Promise<State> {
  const session = await auth();
  if (!session?.user?.id) {
    return {
      message: "ログインしてください",
      success: false,
    };
  }

  const validated = displayNameAndShortDescriptionSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!validated.success) {
    return {
      errors: validated.error.flatten().fieldErrors,
      message: "入力内容に誤りがあります",
      success: false,
    };
  }

  const { displayName, shortDescription, id } = validated.data;
  const result = await prisma.package.update({
    where: {
      id,
      userId: session.user.id,
    },
    data: {
      displayName,
      shortDescription,
    }
  });
  revalidatePath(`/developer/projects/${result.name}`);
  return {
    success: true
  };
}

export async function retrievePackage(name: string) {
  const session = await auth();
  return await prisma.package.findFirst({
    where: {
      name: {
        equals: name,
        mode: "insensitive"
      },
      userId: session?.user?.id
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
        }
      }
    }
  })
}