"use server";

import { authenticated } from "@/lib/auth-guard";
import { headers } from "next/headers";
import { z } from "zod";
import { sendEmail as sendEmailUsingResend } from "@/resend";
import { ConfirmationTokenPurpose } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { getTranslation } from "@/app/i18n/server";
import { getLanguage } from "@/lib/lang-utils";
import { findEmailByUserId } from "@/lib/db/user";
import { deleteManyConfirmationTokens } from "@/lib/db/confirmation-token";
import { addAuditLog, auditLogActions } from "@/lib/audit-log";
import { issueConfirmationToken } from "@/lib/confirmation-token-flow";

type State = {
  message?: string;
  success?: boolean;
};

const emptyStringToUndefined = z.literal("").transform(() => undefined);
const emailSchema = z.object({
  cancel: z.literal("true").optional().or(emptyStringToUndefined),
});

async function sendEmail(email: string, token: string, lang: string) {
  const { t } = await getTranslation(lang);
  const urlstr = (await headers()).get("x-url");
  if (!urlstr) {
    throw new Error("URL is missing in headers");
  }
  const url = new URL(urlstr);
  url.pathname = "/account/manage/personal-data/handle";
  url.searchParams.forEach((_, key) => url.searchParams.delete(key));
  url.searchParams.set("token", token);
  url.searchParams.set("identifier", email);
  await sendEmailUsingResend({
    to: email,
    subject: t("account:data.confirmationAccountDeletion.title"),
    body: t("account:data.confirmationAccountDeletion.body", {
      url: url.toString(),
    }),
  });
}

export async function submit(state: State, formData: FormData): Promise<State> {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);
    const validated = emailSchema.safeParse(
      Object.fromEntries(formData.entries()),
    );
    if (!validated.success) {
      console.error(validated.error);
      return {
        message: t("zod:custom"),
        success: false,
      };
    }

    if (validated.data.cancel) {
      await deleteManyConfirmationTokens({
        userId: session.user.id,
        purpose: ConfirmationTokenPurpose.ACCOUNT_DELETE,
      });
      revalidatePath(`/${lang}/account/manage/personal-data`);
      return {
        message: t("account:data.cancelAccountDeletion"),
        success: true,
      };
    }

    const user = await findEmailByUserId({ userId: session.user.id });
    if (!user) {
      return {
        message: t("userNotFound"),
        success: false,
      };
    }
    const token = await issueConfirmationToken({
      identifier: user.email,
      userId: session.user.id,
      purpose: ConfirmationTokenPurpose.ACCOUNT_DELETE,
    });
    const sendRequest = sendEmail(user.email, token, lang);

    await Promise.all([sendRequest]);
    await addAuditLog({
      userId: session.user.id,
      action: auditLogActions.account.sentDeleteAccountConfirmation,
      details: "",
    });
    revalidatePath(`/${lang}/account/manage/personal-data`);
    return {
      message: t("account:data.sentEmail"),
      success: true,
    };
  });
}
