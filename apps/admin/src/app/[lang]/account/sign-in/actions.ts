"use server";

import { getAuth } from "@/lib/better-auth";
import { redirect } from "next/navigation";
import { getTranslation, type Zod } from "@beutl/i18n";
import { getLanguage } from "@beutl/next/language";
import { existsUserByEmail } from "@beutl/db";
import { headers } from "next/headers";
import { resolveSafeReturnUrl } from "@beutl/next/local-redirect";

const emailSchema = (z: Zod) =>
  z.object({
    email: z.string().email(),
    returnUrl: z.string().optional(),
  });

type State = {
  errors?: {
    email?: string[];
  };
  message?: string;
};

export async function signInWithEmailAction(
  state: State,
  formData: FormData,
): Promise<State> {
  const lang = await getLanguage();
  const { z, t } = await getTranslation(lang);
  const validationResult = emailSchema(z).safeParse(
    Object.fromEntries(formData.entries()),
  );
  if (!validationResult.success) {
    return { errors: validationResult.error.flatten().fieldErrors };
  }
  const { email, returnUrl } = validationResult.data;
  // hidden input はクライアントが差し替えられるため、ページ側で正規化済みでも
  // ここで検証し直す。外部オリジンを callbackURL に渡すと better-auth の
  // originCheck に弾かれ、サインイン自体が失敗する。
  const safeReturnUrl = await resolveSafeReturnUrl(returnUrl);

  const userResult = await existsUserByEmail({ email });

  if (!userResult) {
    return { message: t("auth:errors.magicLink") };
  }

  // Better Auth magic link を送信
  const auth = await getAuth();
  const response = await auth.api.signInMagicLink({
    body: {
      email: email,
      callbackURL: safeReturnUrl || `/${lang}/admin`,
      errorCallbackURL: `/${lang}/account/sign-in`,
    },
    headers: await headers(),
  });

  if (!response.status) {
    return { message: t("auth:errors.magicLink") };
  }

  redirect(`/${lang}/account/verify-request`);
}
