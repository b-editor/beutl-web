"use server";

import { getAuth } from "@/lib/better-auth";
import { redirect } from "next/navigation";
import { getTranslation, type Zod } from "@/app/i18n/server";
import { getLanguage } from "@/lib/lang-utils";
import { existsUserByEmail } from "@/lib/db/user";
import { headers } from "next/headers";

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

  const userResult = await existsUserByEmail({ email });

  if (!userResult) {
    // アカウント未作成
    const params = new URLSearchParams();
    params.append("email", email);
    if (returnUrl) {
      params.append("returnUrl", returnUrl);
    }
    redirect(`/${lang}/account/sign-up?${params.toString()}`);
  }

  // Better Auth magic link を送信
  const auth = await getAuth();
  // Magic link APIを呼び出す
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
