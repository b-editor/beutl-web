"use server";

import { signIn } from "@/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/prisma";
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

export async function signInAction(state: State, formData: FormData): Promise<State> {
  const type = formData.get("type") as string;

  if (type === "email") {
    return await signInWithEmail(state, formData);
  }

  if (type === "google") {
    return await signInWithProvider("google", formData.get("returnUrl") as string | undefined);
  }

  if (type === "github") {
    return await signInWithProvider("github", formData.get("returnUrl") as string | undefined);
  }

  return { message: "無効なリクエストです" }
}

async function signInWithProvider(provider: string, returnUrl?: string): Promise<State> {
  await signIn(provider, { redirectTo: returnUrl || "/" });
  return {};
}

async function signInWithEmail(state: State, formData: FormData): Promise<State> {
  const validationResult = emailSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!validationResult.success) {
    return { errors: validationResult.error.flatten().fieldErrors };
  }
  const { email, returnUrl } = validationResult.data;

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
