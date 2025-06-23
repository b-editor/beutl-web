"use server";

import { getTranslation, Zod } from "@/app/i18n/server";
import { authenticated } from "@/lib/auth-guard";
import { getLanguage } from "@/lib/lang-utils";
import { drizzle } from "@/drizzle";
import { profile, socialProfile, socialProfileProvider } from "@/drizzle/schema";
import { and, eq, inArray } from "drizzle-orm";

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
    const db = await drizzle();
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
    // プロフィール更新
    promises.push(
      db.insert(profile)
        .values({
          userId: session.user.id,
          displayName,
          userName,
          bio,
        })
        .onConflictDoUpdate({
          target: profile.userId,
          set: {
            displayName,
            userName,
            bio,
          },
        }),
    );
    const providers = await db.select({
      id: socialProfileProvider.id,
      provider: socialProfileProvider.provider,
    })
    .from(socialProfileProvider)
    .where(inArray(socialProfileProvider.provider, ["x", "github", "youtube", "custom"]));
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
          db.insert(socialProfile)
            .values({
              userId: session.user.id,
              providerId: social.providerId,
              value: social.value,
            })
            .onConflictDoUpdate({
              target: [socialProfile.userId, socialProfile.providerId],
              set: {
                value: social.value,
              },
            }),
        );
      } else {
        promises.push(
          db.delete(socialProfile)
            .where(
              and(
                eq(socialProfile.userId, session.user.id),
                eq(socialProfile.providerId, social.providerId)
              )
            ),
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
