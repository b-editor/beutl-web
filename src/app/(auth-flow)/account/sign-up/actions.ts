"use server";

import { signIn } from "@/auth";

export async function signUpAction(state: { error?: string }, formData: FormData): Promise<{ error?: string }> {
  const type = formData.get("type") as string;

  if (type === "email") {
    return await signInWithEmail(formData);
  }

  if (type === "google") {
    return await signInWithProvider(formData);
  }

  return { error: "無効なリクエストです" }
}

async function signInWithProvider(formData: FormData): Promise<{ error?: string }> {
  const provider = formData.get("type") as string;
  const returnUrl = formData.get("returnUrl") as string | undefined;
  if (provider !== "google") {
    return { error: "無効なリクエストです" };
  }

  await signIn(provider, { redirectTo: returnUrl || "/" });
  return {};
}

async function signInWithEmail(formData: FormData): Promise<{ error?: string }> {
  const email = formData.get("email") as string;
  const returnUrl = formData.get("returnUrl") as string | undefined;
  if (!email) {
    return { error: "メールアドレスを入力してください" };
  }

  await signIn("nodemailer", { email, redirectTo: returnUrl || "/" });
  return {};
}
