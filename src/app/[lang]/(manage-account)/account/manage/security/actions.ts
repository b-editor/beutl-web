"use server";

import { auth, signIn } from "@/auth";
import { prisma } from "@/prisma";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { authenticated, throwIfUnauth } from "@/lib/auth-guard";
import { getLanguage } from "@/lib/lang-utils";
import { getTranslation } from "@/app/i18n/server";

export type State = {
  success?: boolean;
  message?: string | null;
};

export async function addAccount(state: State, formData: FormData): Promise<State> {
  const type = formData.get("type") as string | null;
  const lang = getLanguage();
  const { t } = await getTranslation(lang);

  if (!type || (type !== "google" && type !== "github" && type !== "passkey")) {
    return { message: t("invalidRequest"), success: false };
  }

  const url = new URL(headers().get("x-url") as string);
  url.pathname = `/${lang}/account/manage/security/handle`;
  cookies().set(
    "beutl.auth-flow",
    JSON.stringify({
      type: "adding-account",
      url: url.toString(),
    }),
  );
  await signIn(type, { redirectTo: `${url.origin}/${lang}/account/manage/security` });
  return { success: true };
}

export async function removeAccount(state: State, formData: FormData): Promise<State> {
  return await authenticated(async (session) => {
    const lang = getLanguage();
    const { t } = await getTranslation(lang);
    const providerAccountId = formData.get("providerAccountId") as
      | string
      | null;
    const provider = formData.get("provider") as string | null;

    if (!providerAccountId || !provider) {
      return { success: false, message: t("invalidRequest") };
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
      return { success: false, message: "Account not found" };
    }

    const remain = user.accounts.filter(
      (account) =>
        !(
          account.providerAccountId === providerAccountId &&
          account.provider === provider
        ),
    );
    if (remain.length === user.accounts.length) {
      return { success: false, message: "Account not found" };
    }

    if (remain.length === 0) {
      console.log("Deleting the last account");
      if (!user.emailVerified) {
        console.log("The user is not verified");
        return {
          success: false,
          message: t("account:security.cannotRemoveAccount"),
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
    revalidatePath(`/${lang}/account/manage/security`);
    return { success: true };
  });
}

export async function renameAuthenticator({ id, name }: { id: string, name: string }): Promise<void> {
  const session = await throwIfUnauth();
  const lang = getLanguage();
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
  revalidatePath(`/${lang}/account/manage/security`);
  redirect(`/${lang}/account/manage/security`);
}

export async function deleteAuthenticator({ id }: { id: string }): Promise<{error?: string}> {
  const session = await throwIfUnauth();
  const lang = getLanguage();
  const { t } = await getTranslation(lang);
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
    return { error: "Account not found" };
  }

  const remain = user.accounts.filter(
    (account) =>
      !(account.providerAccountId === id && account.provider === "passkey"),
  );
  if (remain.length === user.accounts.length) {
    return { error: "Account not found" };
  }

  if (remain.length === 0) {
    console.log("Deleting the last account");
    if (!user.emailVerified) {
      console.log("The user is not verified");
      return { error: t("account:security.cannotRemoveAccount") };
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
  revalidatePath(`/${lang}/account/manage/security`);
  redirect(`/${lang}/account/manage/security`);
}
