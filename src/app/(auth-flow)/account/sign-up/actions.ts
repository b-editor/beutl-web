"use server";

import { signIn } from "@/auth";
import { z } from "zod";

const emailSchema = z.object({
  email: z.string().email("メールアドレスが正しくありません"),
  returnUrl: z.string().optional(),
});

type State = {
  errors?: {
    email?: string[];
  };
  message?: string;
}

export async function signUpAction(state: State, formData: FormData): Promise<State> {
  const type = formData.get("type") as string;

  if (type === "email") {
    return await signInWithEmail(formData);
  }

  if (type === "google" || type === "github") {
    return await signInWithProvider(formData);
  }

  return { message: "無効なリクエストです" }
}

async function signInWithProvider(formData: FormData): Promise<State> {
  const provider = formData.get("type") as string;
  const returnUrl = formData.get("returnUrl") as string | undefined;
  if (provider !== "google" && provider !== "github") {
    return { message: "無効なリクエストです" };
  }

  await signIn(provider, { redirectTo: returnUrl || "/" });
  return {};
}

async function signInWithEmail(formData: FormData): Promise<State> {
  const validationResult = emailSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!validationResult.success) {
    return { errors: validationResult.error.flatten().fieldErrors };
  }
  const { email, returnUrl } = validationResult.data;

  await signIn("nodemailer", { email, redirectTo: returnUrl || "/" });
  return {};
}
