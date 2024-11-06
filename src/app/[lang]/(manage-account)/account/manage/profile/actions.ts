"use server";

import { authenticated, authOrSignIn } from "@/lib/auth-guard";
import { prisma } from "@/prisma";
import { z } from "zod";

const emptyStringToUndefined = z.literal('').transform(() => undefined);
const profileSchema = z.object({
  displayName: z.string().max(50, "表示名は50文字以下である必要があります"),
  userName: z.string().regex(/^[a-zA-Z0-9-_]*$/, "ユーザー名は半角英数字とハイフン、アンダースコアのみ使用できます"),
  bio: z.string().max(150, "自己紹介は150文字以下である必要があります").optional().or(z.literal('')),
  x: z.string().startsWith("@").optional().or(emptyStringToUndefined),
  github: z.string().optional().or(emptyStringToUndefined),
  youtube: z.string().startsWith("@").optional().or(emptyStringToUndefined),
  custom: z.string().url("有効なURLを入力してください").optional().or(emptyStringToUndefined),
});

export type State = {
  errors?: {
    displayName?: string[];
    userName?: string[];
    bio?: string[];
    x?: string[];
    github?: string[];
    youtube?: string[];
    custom?: string[];
  };
  success?: boolean;
  message?: string | null;
};

export async function updateProfile(state: State, formData: FormData): Promise<State> {
  return await authenticated(async (session) => {
    const validated = profileSchema.safeParse(
      Object.fromEntries(formData.entries()),
    );
    if (!validated.success) {
      return {
        errors: validated.error.flatten().fieldErrors,
        message: "入力内容に誤りがあります",
        success: false,
      };
    }

    const { displayName, userName, bio, x, github, youtube, custom } =
      validated.data;

    const promises: Promise<unknown>[] = [];
    // プロフィール更新
    promises.push(
      prisma.profile.upsert({
        where: {
          userId: session.user.id,
        },
        update: {
          displayName,
          userName,
          bio,
        },
        create: {
          userId: session.user.id,
          displayName,
          userName,
          bio,
        },
      }),
    );
    const providers = await prisma.socialProfileProvider.findMany({
      where: {
        name: {
          in: ["x", "github", "youtube", "custom"],
        },
      },
      select: {
        id: true,
        name: true,
      },
    });
    const socials = [
      {
        providerId: providers.find((p) => p.name === "x")?.id,
        value: x
      },
      {
        providerId: providers.find((p) => p.name === "github")?.id,
        value: github,
      },
      {
        providerId: providers.find((p) => p.name === "youtube")?.id,
        value: youtube,
      },
      {
        providerId: providers.find((p) => p.name === "custom")?.id,
        value: custom,
      },
    ];
    for (const social of socials) {
      if (!social.providerId) {
        continue;
      }
      if (social.value) {
        promises.push(
          prisma.socialProfile.upsert({
            where: {
              userId_providerId: {
                userId: session.user.id,
                providerId: social.providerId,
              },
            },
            update: {
              value: social.value,
            },
            create: {
              userId: session.user.id,
              providerId: social.providerId,
              value: social.value,
            },
          }),
        );
      } else {
        promises.push(
          prisma.socialProfile.delete({
            where: {
              userId_providerId: {
                userId: session.user.id,
                providerId: social.providerId,
              },
            },
          }),
        );
      }
    }

    await Promise.all(promises);
    return {
      success: true,
      message: "プロフィールを更新しました",
    };
  });
}