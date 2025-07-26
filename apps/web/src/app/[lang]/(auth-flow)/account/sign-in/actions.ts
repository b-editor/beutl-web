"use server";

import { signIn } from "@/auth";
import { redirect } from "next/navigation";
import { getTranslation, type Zod } from "@/app/i18n/server";
import { getLanguage } from "@/lib/lang-utils";
import { existsUserByEmail } from "@/lib/db/user";

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

export async function signInAction(
  state: State,
  formData: FormData,
): Promise<State> {
  const type = formData.get("type") as string;

  if (type === "email") {
    return await signInWithEmail(state, formData);
  }

  if (type === "google") {
    return await signInWithProvider(
      "google",
      formData.get("returnUrl") as string | undefined,
    );
  }

  if (type === "github") {
    return await signInWithProvider(
      "github",
      formData.get("returnUrl") as string | undefined,
    );
  }

  const { t } = await getTranslation(await getLanguage());
  return { message: t("invalidRequest") };
}

async function signInWithProvider(
  provider: string,
  returnUrl?: string,
): Promise<State> {
  await signIn(provider, { redirectTo: returnUrl || "/" });
  return {};
}

async function signInWithEmail(
  state: State,
  formData: FormData,
): Promise<State> {
  const lang = await getLanguage();
  const { z } = await getTranslation(lang);
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

  await signIn("resend", { email, redirectTo: returnUrl || `/${lang}` });
  return {};
}
