"use server";

import { getTranslation, Translator, Zod } from "@/app/i18n/server";
import { signIn } from "@/auth";
import { getLanguage } from "@/lib/lang-utils";

const emailSchema = (z: Zod) => z.object({
  email: z.string().email(),
  returnUrl: z.string().optional(),
});

type State = {
  errors?: {
    email?: string[];
  };
  message?: string;
}

export async function signUpAction(state: State, formData: FormData): Promise<State> {
  const { t, z } = await getTranslation(getLanguage());
  const type = formData.get("type") as string;

  if (type === "email") {
    return await signInWithEmail(formData, z);
  }

  if (type === "google" || type === "github") {
    return await signInWithProvider(formData, t);
  }

  return { message: t("invalidRequest") }
}

async function signInWithProvider(formData: FormData, t: Translator): Promise<State> {
  const provider = formData.get("type") as string;
  const returnUrl = formData.get("returnUrl") as string | undefined;
  if (provider !== "google" && provider !== "github") {
    return { message: t("invalidRequest") };
  }

  await signIn(provider, { redirectTo: returnUrl || `/${getLanguage()}` });
  return {};
}

async function signInWithEmail(formData: FormData, z: Zod): Promise<State> {
  const validationResult = emailSchema(z).safeParse(Object.fromEntries(formData.entries()));
  if (!validationResult.success) {
    return { errors: validationResult.error.flatten().fieldErrors };
  }
  const { email, returnUrl } = validationResult.data;

  await signIn("nodemailer", { email, redirectTo: returnUrl || `/${getLanguage()}` });
  return {};
}
