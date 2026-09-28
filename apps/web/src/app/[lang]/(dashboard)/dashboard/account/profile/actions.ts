"use server";

import { getTranslation, Zod } from "@beutl/i18n";
import { authenticated } from "@/lib/auth-guard";
import {
  deleteSocialProfiles,
  getSocialProviders,
  ProfileUserNameTakenError,
  startRetryableTransaction,
  upsertProfile,
  upsertSocialProfile,
} from "@beutl/db";
import { getLanguage } from "@beutl/next/language";
import { revalidatePath } from "next/cache";

const emptyStringToUndefined = (z: Zod) =>
  z.literal("").transform(() => undefined);
const profileSchema = (z: Zod) =>
  z.object({
    displayName: z.string().max(50),
    userName: z.string().regex(/^[a-zA-Z0-9_-]+$/),
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

    try {
      await startRetryableTransaction(async (prisma) => {
        // A rejected name must not partially change the social links either.
        await upsertProfile({ userId: session.user.id, displayName, userName, bio, prisma });
        const values: Record<string, string | undefined> = { x, github, youtube, custom };
        const providers = await getSocialProviders(Object.keys(values), prisma);
        await Promise.all(providers.map((provider) => {
          const value = values[provider.provider];
          return value
            ? upsertSocialProfile({ userId: session.user.id, providerId: provider.id, value, prisma })
            : deleteSocialProfiles({ userId: session.user.id, providerId: provider.id, prisma });
        }));
      });
    } catch (error) {
      if (!(error instanceof ProfileUserNameTakenError)) throw error;
      const message = t("account:profile.userNameTaken");
      return { success: false, message, errors: { userName: [message] } };
    }
    revalidatePath(`/${lang}/dashboard/account/profile`);
    return {
      success: true,
      message: t("account:profile.profileUpdated"),
    };
  });
}
