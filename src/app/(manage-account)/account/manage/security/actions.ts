"use server";

import { auth, signIn } from "@/auth";
import { prisma } from "@/prisma";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { authenticated, throwIfUnauth } from "@/lib/auth-guard";

export type State = {
  success?: boolean;
  message?: string | null;
};

export async function addAccount(state: State, formData: FormData): Promise<State> {
  const type = formData.get("type") as string | null;

  if (!type || (type !== "google" && type !== "github" && type !== "passkey")) {
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
  await signIn(type, { redirectTo: `${url.origin}/account/manage/security` });
  return { success: true };
}

export async function removeAccount(state: State, formData: FormData): Promise<State> {
  return await authenticated(async (session) => {
    const providerAccountId = formData.get("providerAccountId") as
      | string
      | null;
    const provider = formData.get("provider") as string | null;

    if (!providerAccountId || !provider) {
      return { success: false, message: "入力内容に誤りがあります" };
    }

    const user = await prisma.user.findFirst({
      where: {
        id: session.user.id,
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

    const remain = user.accounts.filter(
      (account) =>
        !(
          account.providerAccountId === providerAccountId &&
          account.provider === provider
        ),
    );
    if (remain.length === user.accounts.length) {
      return { success: false, message: "アカウントが見つかりません" };
    }

    if (remain.length === 0) {
      console.log("Deleting the last account");
      if (!user.emailVerified) {
        console.log("The user is not verified");
        return {
          success: false,
          message:
            "サインイン方法がなくなるため、このアカウントは削除できません。メールアドレスが確認するか、サインイン方法を追加してください。",
        };
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
    if (provider === "passkey") {
      await prisma.authenticator.delete({
        where: {
          userId_credentialID: {
            userId: session.user.id,
            credentialID: providerAccountId,
          },
        },
      });
    }
    revalidatePath("/account/manage/security");
    return { success: true };
  });
}

export async function renameAuthenticator({ id, name }: { id: string, name: string }): Promise<void> {
  return await throwIfUnauth(async (session) => {
    await prisma.authenticator.update({
      where: {
        userId_credentialID: {
          userId: session.user.id,
          credentialID: id,
        },
      },
      data: {
        name,
      },
    });
    revalidatePath("/account/manage/security");
    redirect("/account/manage/security");
  });
}

export async function deleteAuthenticator({ id }: { id: string }): Promise<void> {
  return await throwIfUnauth(async (session) => {
    const user = await prisma.user.findFirst({
      where: {
        id: session.user.id,
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
      throw new Error("アカウントが見つかりません");
    }

    const remain = user.accounts.filter(
      (account) =>
        !(account.providerAccountId === id && account.provider === "passkey"),
    );
    if (remain.length === user.accounts.length) {
      throw new Error("アカウントが見つかりません");
    }

    if (remain.length === 0) {
      console.log("Deleting the last account");
      if (!user.emailVerified) {
        console.log("The user is not verified");
        throw new Error(
          "サインイン方法がなくなるため、このアカウントは削除できません。メールアドレスが確認するか、サインイン方法を追加してください。",
        );
      }
    }

    await prisma.account.delete({
      where: {
        provider_providerAccountId: {
          providerAccountId: id,
          provider: "passkey",
        },
      },
    });
    await prisma.authenticator.delete({
      where: {
        userId_credentialID: {
          userId: session.user.id,
          credentialID: id,
        },
      },
    });
    revalidatePath("/account/manage/security");
    redirect("/account/manage/security");
  });
}
