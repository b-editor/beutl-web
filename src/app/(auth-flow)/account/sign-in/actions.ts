"use server";

import { signIn } from "@/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/prisma";

export async function signInAction(state: { error?: string }, formData: FormData): Promise<{ error?: string }> {
  const type = formData.get("type") as string;

  if (type === "email") {
    return await signInWithEmail(state, formData);
  }

  if (type === "google") {
    return await signInWithProvider("google", formData.get("returnUrl") as string | undefined);
  }

  return { error: "無効なリクエストです" }
}

async function signInWithProvider(provider: string, returnUrl?: string): Promise<{ error?: string }> {
  await signIn(provider, { redirectTo: returnUrl || "/" });
  return {};
}

async function signInWithEmail(state: { error?: string }, formData: FormData): Promise<{ error?: string }> {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const email = formData.get("email") as string;
  const returnUrl = formData.get("returnUrl") as string | undefined;
  if (!email) {
    return { error: "メールアドレスを入力してください" };
  }

  const userResult = await prisma.user.findFirst({ where: { email: email } });

  if (!userResult) {
    // アカウント未作成
    const params = new URLSearchParams();
    params.append("email", email);
    if (returnUrl) {
      params.append("returnUrl", returnUrl);
    }
    redirect(`/account/sign-up?${params.toString()}`);
  }

  await signIn("nodemailer", { email, redirectTo: returnUrl || "/" });
  return {};
}
