"use server";

import { signIn } from "@/auth";
import { prisma } from "@/prisma";
import { redirect } from "next/navigation";

export async function signInWithProvider(formData: FormData) {
  const provider = formData.get("provider") as string;
  const returnUrl = formData.get("returnUrl") as string | undefined;
  if (provider !== "google") {
    return;
  }

  await signIn(provider, { redirectTo: returnUrl || "/" });
}

export async function signInWithEmail(state: { errors?: { email?: string } } | undefined, formData: FormData) {
  const email = formData.get("email") as string;
  const returnUrl = formData.get("returnUrl") as string | undefined;
  if (!email) {
    return {
      errors: {
        email: "メールアドレスを入力してください"
      }
    }
  }
  if (!/^[A-Za-z0-9]{1}[A-Za-z0-9_.-]*@{1}[A-Za-z0-9_.-]{1,}\.[A-Za-z0-9]{1,}$/.test(email)) {
    return {
      errors: {
        email: "有効なメールアドレスを入力してください"
      }
    }
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
}
