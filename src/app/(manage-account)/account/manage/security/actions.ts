"use server";

import { auth, signIn } from "@/auth";
import { prisma } from "@/prisma";
import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";

export type State = {
  success?: boolean;
  message?: string | null;
};

export async function addAccount(state: State, formData: FormData): Promise<State> {
  const type = formData.get("type") as string | null;

  if (!type || (type !== "google" && type !== "github")) {
    return { message: "入力内容に誤りがあります", success: false };
  }

  const url = new URL(headers().get("x-url") as string);
  url.pathname = "/account/manage/security/handle";
  cookies().set(
    "beutl.auth-flow",
    JSON.stringify({
      type: "adding-account",
      url: url.toString(),
    }),
  );
  await signIn(type, { redirectTo: "/account/manage/security" });
  return { success: true };
}

export async function removeAccount(state: State, formData: FormData): Promise<State> {
  const providerAccountId = formData.get("providerAccountId") as string | null;
  const provider = formData.get("provider") as string | null;
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return { success: false, message: "ログインしてください" };
  }

  if (!providerAccountId || !provider) {
    return { success: false, message: "入力内容に誤りがあります" };
  }

  const user = await prisma.user.findFirst({
    where: {
      id: userId,
    },
    select: {
      emailVerified: true,
      accounts: {
        select: {
          providerAccountId: true,
          provider: true,
        },
      },
    },
  });
  if (!user) {
    return { success: false, message: "アカウントが見つかりません" };
  }

  const remain = user.accounts
    .filter((account) => !(account.providerAccountId === providerAccountId && account.provider === provider));
  if (remain.length === user.accounts.length) {
    return { success: false, message: "アカウントが見つかりません" };
  }

  if (remain.length === 0) {
    console.log("Deleting the last account");
    if (!user.emailVerified) {
      console.log("The user is not verified");
      return { success: false, message: "サインイン方法がなくなるため、このアカウントは削除できません。メールアドレスが確認するか、サインイン方法を追加してください。" };
    }
  }

  await prisma.account.delete({
    where: {
      provider_providerAccountId: {
        providerAccountId,
        provider,
      },
    },
  });
  revalidatePath("/account/manage/security");
  return { success: true };
}