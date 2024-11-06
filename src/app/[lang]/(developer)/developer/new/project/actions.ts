"use server";

import { auth } from "@/auth";
import { authenticated } from "@/lib/auth-guard";
import { prisma } from "@/prisma";
import { redirect } from "next/navigation";
import { z } from "zod";

export type State = {
  errors?: {
    packageId?: string[];
  };
  success?: boolean;
  message?: string | null;
};

const formSchema = z.object({
  packageId: z.string().regex(/^[a-zA-Z0-9_.]*$/, "パッケージIDは半角英数字とピリオド、アンダースコアのみ使用できます")
    .and(z.string().max(50, "パッケージIDは50文字以下である必要があります"))
    .and(z.string().min(3, "パッケージIDは3文字以上である必要があります")),
});


export async function createNewProject(state: State, formData: FormData): Promise<State> {
  return await authenticated(async session => {
    const validated = formSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!validated.success) {
      return {
        errors: validated.error.flatten().fieldErrors,
        message: "入力内容に誤りがあります",
        success: false,
      };
    }

    const { packageId } = validated.data;
    const existing = await prisma.package.count({
      where: {
        name: {
          equals: packageId,
          mode: "insensitive",
        }
      },
    });
    if (existing) {
      return {
        errors: {
          packageId: ["このパッケージIDは既に使用されています"],
        },
        message: "入力内容に誤りがあります",
        success: false,
      };
    }
    await prisma.package.create({
      data: {
        name: packageId,
        userId: session.user.id,
        description: "",
        shortDescription: "",
        webSite: "",
        published: false,
      }
    });
    redirect(`/developer/projects/${packageId}`);
  });
}