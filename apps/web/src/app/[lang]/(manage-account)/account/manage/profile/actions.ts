"use server";

import { getTranslation, Zod } from "@/app/i18n/server";
import { authenticated } from "@/lib/auth-guard";
import { getLanguage } from "@/lib/lang-utils";
import { getDbAsync } from "@/prisma";

const emptyStringToUndefined = (z: Zod) =>
  z.literal("").transform(() => undefined);
const profileSchema = (z: Zod) =>
  z.object({
    displayName: z.string().max(50),
    userName: z.string().regex(/^[a-zA-Z0-9-_]*$/),
    bio: z.string().max(150).optional().or(z.literal("")),
    x: z.string().startsWith("@").optional().or(emptyStringToUndefined(z)),
    github: z.string().optional().or(emptyStringToUndefined(z)),
    youtube: z
      .string()
      .startsWith("@")
      .optional()
      .or(emptyStringToUndefined(z)),
    custom: z.string().url().optional().or(emptyStringToUndefined(z)),
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

export async function updateProfile(
  state: State,
  formData: FormData,
): Promise<State> {
  return await authenticated(async (session) => {
    const { t, z } = await getTranslation(await getLanguage());
    const validated = profileSchema(z).safeParse(
      Object.fromEntries(formData.entries()),
    );
    if (!validated.success) {
      return {
        errors: validated.error.flatten().fieldErrors,
        message: t("invalidRequest"),
        success: false,
      };
    }

    const { displayName, userName, bio, x, github, youtube, custom } =
      validated.data;

    const promises: Promise<unknown>[] = [];
    const db = await getDbAsync();
    // プロフィール更新
    promises.push(
      db.profile.upsert({
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
    const providers = await db.socialProfileProvider.findMany({
      where: {
        provider: {
          in: ["x", "github", "youtube", "custom"],
        },
      },
      select: {
        id: true,
        provider: true,
      },
    });
    const socials = [
      {
        providerId: providers.find((p) => p.provider === "x")?.id,
        value: x,
      },
      {
        providerId: providers.find((p) => p.provider === "github")?.id,
        value: github,
      },
      {
        providerId: providers.find((p) => p.provider === "youtube")?.id,
        value: youtube,
      },
      {
        providerId: providers.find((p) => p.provider === "custom")?.id,
        value: custom,
      },
    ];
    for (const social of socials) {
      if (!social.providerId) {
        continue;
      }
      if (social.value) {
        promises.push(
          db.socialProfile.upsert({
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
          db.socialProfile.deleteMany({
            where: {
              userId: session.user.id,
              providerId: social.providerId,
            },
          }),
        );
      }
    }

    await Promise.all(promises);
    return {
      success: true,
      message: t("account:profile.profileUpdated"),
    };
  });
}
