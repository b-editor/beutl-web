"use server";

import { getTranslation, Zod } from "@/app/i18n/server";
import { authenticated } from "@/lib/auth-guard";
import {
  deleteSocialProfiles,
  getSocialProviders,
  upsertProfile,
  upsertSocialProfile,
} from "@/lib/db/profile";
import { getLanguage } from "@/lib/lang-utils";
import { revalidatePath } from "next/cache";

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
    const lang = await getLanguage();
    const { t, z } = await getTranslation(lang);
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
      upsertProfile({
        userId: session.user.id,
        displayName,
        userName,
        bio,
      }),
    );
    const providers = await getSocialProviders([
      "x",
      "github",
      "youtube",
      "custom",
    ]);
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
          upsertSocialProfile({
            userId: session.user.id,
            providerId: social.providerId,
            value: social.value,
          }),
        );
      } else {
        promises.push(
          deleteSocialProfiles({
            userId: session.user.id,
            providerId: social.providerId,
          }),
        );
      }
    }

    await Promise.all(promises);
    revalidatePath(`/${lang}/account/manage/profile`);
    return {
      success: true,
      message: t("account:profile.profileUpdated"),
    };
  });
}
