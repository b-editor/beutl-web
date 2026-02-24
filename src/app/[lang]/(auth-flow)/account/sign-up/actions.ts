"use server";

import { getTranslation, type Zod } from "@/app/i18n/server";
import { getAuth } from "@/lib/better-auth";
import { getLanguage } from "@/lib/lang-utils";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

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

// サインアップはemailのみをサポート（OAuthは自動的にアカウント作成される）
export async function signUpWithEmailAction(
  state: State,
  formData: FormData,
): Promise<State> {
  const lang = await getLanguage();
  const { t, z } = await getTranslation(lang);
  const auth = await getAuth();

  const validationResult = emailSchema(z).safeParse(
    Object.fromEntries(formData.entries()),
  );
  if (!validationResult.success) {
    return { errors: validationResult.error.flatten().fieldErrors };
  }
  const { email, returnUrl } = validationResult.data;

  // Better Auth magic link を送信
  const response = await auth.api.signInMagicLink({
      body: {
        email: email,
        callbackURL: returnUrl || `/${lang}`,
        errorCallbackURL: "/account/error",
      },
      headers: await headers(),
    });

  if (!response.status) {
    return { message: t("auth:errors.magicLink") };
  }

  // メール送信後、確認ページにリダイレクト
  redirect(`/${lang}/account/verify-request`);
}
