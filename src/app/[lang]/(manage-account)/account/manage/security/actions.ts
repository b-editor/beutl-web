"use server";

import { auth, signIn } from "@/auth";
import { prisma } from "@/prisma";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { authenticated, throwIfUnauth } from "@/lib/auth-guard";
import { getLanguage } from "@/lib/lang-utils";
import { getTranslation } from "@/app/i18n/server";
import { getEmailVerifiedByUserId } from "@/lib/db/user";
import { deleteAccount, retrieveAccounts } from "@/lib/db/account";
import {
  deleteAuthenticator as deleteDbAuthenticator,
  updateAuthenticatorName,
} from "@/lib/db/authenticator";
import { startTransaction } from "@/lib/db/transaction";
import { addAuditLog, auditLogActions } from "@/lib/audit-log";

export type State = {
  success?: boolean;
  message?: string | null;
};

export async function addAccount(
  state: State,
  formData: FormData,
): Promise<State> {
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
  await signIn(type, {
    redirectTo: `${url.origin}/${lang}/account/manage/security`,
  });
  return { success: true };
}

export async function removeAccount(
  state: State,
  formData: FormData,
): Promise<State> {
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

    const accounts = await retrieveAccounts({ userId: session.user.id });
    if (!accounts.length) {
      return { success: false, message: "Account not found" };
    }

    const remain = accounts.filter(
      (account) =>
        !(
          account.providerAccountId === providerAccountId &&
          account.provider === provider
        ),
    );
    if (remain.length === accounts.length) {
      return { success: false, message: "Account not found" };
    }

    if (remain.length === 0) {
      console.log("Deleting the last account");
      if (!(await getEmailVerifiedByUserId({ userId: session.user.id }))) {
        console.log("The user is not verified");
        return {
          success: false,
          message: t("account:security.cannotRemoveAccount"),
        };
      }
    }

    await deleteAccount({ providerAccountId, provider });
    if (provider === "passkey") {
      await deleteDbAuthenticator({
        userId: session.user.id,
        credentialID: providerAccountId,
      });
    }
    revalidatePath(`/${lang}/account/manage/security`);
    await addAuditLog({
      userId: session.user.id,
      action: auditLogActions.account.signInMethodDeleted,
      details: `provider: ${provider}, providerAccountId: ${providerAccountId}`,
    });
    return { success: true };
  });
}

export async function renameAuthenticator({
  id,
  name,
}: { id: string; name: string }): Promise<void> {
  const session = await throwIfUnauth();
  const lang = getLanguage();
  await updateAuthenticatorName({
    credentialID: id,
    userId: session.user.id,
    name,
  });
  revalidatePath(`/${lang}/account/manage/security`);
  redirect(`/${lang}/account/manage/security`);
}

export async function deleteAuthenticator({
  id,
}: { id: string }): Promise<{ error?: string }> {
  const session = await throwIfUnauth();
  const lang = getLanguage();
  const { t } = await getTranslation(lang);
  const accounts = await retrieveAccounts({ userId: session.user.id });
  if (!accounts.length) {
    return { error: "Account not found" };
  }

  const remain = accounts.filter(
    (account) =>
      !(account.providerAccountId === id && account.provider === "passkey"),
  );
  if (remain.length === accounts.length) {
    return { error: "Account not found" };
  }

  if (remain.length === 0) {
    console.log("Deleting the last account");
    if (!(await getEmailVerifiedByUserId({ userId: session.user.id }))) {
      console.log("The user is not verified");
      return { error: t("account:security.cannotRemoveAccount") };
    }
  }

  await startTransaction(async (p) => {
    await deleteAccount({
      providerAccountId: id,
      provider: "passkey",
      prisma: p,
    });
    await deleteDbAuthenticator({
      userId: session.user.id,
      credentialID: id,
      prisma: p,
    });
  });
  await addAuditLog({
    userId: session.user.id,
    action: auditLogActions.account.signInMethodDeleted,
    details: `provider: passkey, providerAccountId: ${id}`,
  });
  revalidatePath(`/${lang}/account/manage/security`);
  redirect(`/${lang}/account/manage/security`);
}
