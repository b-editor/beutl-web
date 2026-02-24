"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authenticated, throwIfUnauth } from "@/lib/auth-guard";
import { getLanguage } from "@/lib/lang-utils";
import { getTranslation } from "@/app/i18n/server";
import { getEmailVerifiedByUserId } from "@/lib/db/user";
import { deleteAccount, retrieveAccounts } from "@/lib/db/account";
import {
  deletePasskey as deleteDbPasskey,
  getPasskeysByUserId,
  updatePasskeyName,
} from "@/lib/db/passkey";
import { addAuditLog, auditLogActions } from "@/lib/audit-log";

export type State = {
  success?: boolean;
  message?: string | null;
};

export async function removeAccount(
  state: State,
  formData: FormData,
): Promise<State> {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);
    const accountId = formData.get("accountId") as string | null;
    const providerId = formData.get("providerId") as string | null;

    if (!accountId || !providerId) {
      return { success: false, message: t("invalidRequest") };
    }

    const accounts = await retrieveAccounts({ userId: session.user.id });
    if (!accounts.length) {
      return { success: false, message: "Account not found" };
    }

    const remain = accounts.filter(
      (account) =>
        !(
          account.accountId === accountId &&
          account.providerId === providerId
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

    await deleteAccount({ accountId, providerId });
    revalidatePath(`/${lang}/account/manage/security`);
    await addAuditLog({
      userId: session.user.id,
      action: auditLogActions.account.signInMethodDeleted,
      details: `provider: ${providerId}, accountId: ${accountId}`,
    });
    return { success: true };
  });
}

export async function renamePasskey({
  id,
  name,
}: { id: string; name: string }): Promise<void> {
  const session = await throwIfUnauth();
  const lang = await getLanguage();
  await updatePasskeyName({
    credentialID: id,
    userId: session.user.id,
    name,
  });
  revalidatePath(`/${lang}/account/manage/security`);
  redirect(`/${lang}/account/manage/security`);
}

export async function deletePasskey({
  id,
}: { id: string }): Promise<{ error?: string }> {
  const session = await throwIfUnauth();
  const lang = await getLanguage();
  const { t } = await getTranslation(lang);

  // Passkeysを別途取得
  const passkeys = await getPasskeysByUserId({ userId: session.user.id });
  const accounts = await retrieveAccounts({ userId: session.user.id });

  // 合計の認証方法数をチェック
  const totalAuthMethods = accounts.length + passkeys.length;

  const passkeyToDelete = passkeys.find((p) => p.credentialID === id);
  if (!passkeyToDelete) {
    return { error: "Passkey not found" };
  }

  if (totalAuthMethods <= 1) {
    console.log("Deleting the last auth method");
    if (!(await getEmailVerifiedByUserId({ userId: session.user.id }))) {
      console.log("The user is not verified");
      return { error: t("account:security.cannotRemoveAccount") };
    }
  }

  await deleteDbPasskey({
    userId: session.user.id,
    credentialID: id,
  });

  await addAuditLog({
    userId: session.user.id,
    action: auditLogActions.account.signInMethodDeleted,
    details: `provider: passkey, credentialID: ${id}`,
  });
  revalidatePath(`/${lang}/account/manage/security`);
  redirect(`/${lang}/account/manage/security`);
}
