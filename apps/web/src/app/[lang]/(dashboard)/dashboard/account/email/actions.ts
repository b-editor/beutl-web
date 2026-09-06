"use server";

import { authenticated } from "@/lib/auth-guard";
import { headers } from "next/headers";
import { sendEmail as sendEmailUsingResend } from "@beutl/email";
import { redirect, RedirectType } from "next/navigation";
import { revalidatePath } from "next/cache";
import { ConfirmationTokenPurpose } from "@prisma/client";
import { getTranslation, type Zod } from "@beutl/i18n";
import { getLanguage } from "@beutl/next/language";
import {
  existsUserByEmail,
  existsUserById,
  updateUserEmail,
} from "@beutl/db";
import { updateCustomerEmailIfExist } from "@/lib/customer";
import { startTransaction } from "@beutl/db";
import { addAuditLog, auditLogActions } from "@beutl/next/audit-log";
import {
  consumeConfirmationToken,
  issueConfirmationToken,
  validateConfirmationToken,
} from "@/lib/confirmation-token-flow";

type State = {
  message?: string;
  success?: boolean;
};

const emailSchema = (z: Zod) =>
  z.object({
    newEmail: z.string().email(),
  });

async function sendEmail(email: string, token: string) {
  const lang = await getLanguage();
  const { t } = await getTranslation(lang);
  const urlstr = (await headers()).get("x-url");
  if (!urlstr) {
    throw new Error("URL is missing in headers");
  }
  const url = new URL(urlstr);
  url.pathname = `/${lang}/dashboard/account/email`;
  url.searchParams.forEach((_, key) => url.searchParams.delete(key));
  url.searchParams.set("token", token);
  url.searchParams.set("identifier", email);
  await sendEmailUsingResend({
    to: email,
    subject: t("account:email.changeEmail"),
    body: `
      <p>${t("account:email.clickOnTheLink")}</p>
      <a href="${url.toString()}">${t("change")}</a>
    `,
  });
}

export async function sendConfirmationEmail(
  state: State,
  formData: FormData,
): Promise<State> {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t, z } = await getTranslation(lang);
    const validated = emailSchema(z).safeParse(
      Object.fromEntries(formData.entries()),
    );
    if (!validated.success) {
      return {
        message: validated.error.issues[0]?.message ?? t("invalidRequest"),
        success: false,
      };
    }

    // メールアドレス更新
    if (!(await existsUserById({ id: session.user.id }))) {
      return {
        message: t("userNotFound"),
        success: false,
      };
    }
    if (await existsUserByEmail({ email: validated.data.newEmail })) {
      return {
        message: t("account:email.emailExists"),
        success: false,
      };
    }
    const token = await issueConfirmationToken({
      identifier: validated.data.newEmail,
      userId: session.user.id,
      purpose: ConfirmationTokenPurpose.EMAIL_UPDATE,
    });
    const sendRequest = sendEmail(validated.data.newEmail, token);

    await Promise.all([sendRequest]);
    await addAuditLog({
      userId: session.user.id,
      action: auditLogActions.account.sentEmailChangeConfirmation,
      details: `email: ${validated.data.newEmail}`,
    });
    return {
      message: t("account:email.emailSent"),
      success: true,
    };
  });
}

export async function updateEmail(token: string, identifier: string) {
  const lang = await getLanguage();
  const result = await validateConfirmationToken({
    token,
    identifier,
    purpose: ConfirmationTokenPurpose.EMAIL_UPDATE,
  });
  if (!result.valid) {
    console.error(
      result.reason === "expired" ? "Token has expired" : "Invalid token",
    );
    redirect(
      `/${lang}/dashboard/account/email?status=emailUpdateFailed`,
      RedirectType.replace,
    );
  }
  const { tokenData } = result;

  const updated = await startTransaction(async (p) => {
    const consumed = await consumeConfirmationToken({
      token,
      identifier,
      purpose: ConfirmationTokenPurpose.EMAIL_UPDATE,
      prisma: p,
    });
    if (!consumed.valid || consumed.tokenData.userId !== tokenData.userId) {
      return false;
    }
    await updateUserEmail({
      userId: tokenData.userId,
      email: tokenData.identifier,
      prisma: p,
    });
    return true;
  }).catch((e) => {
    console.error("Failed to update email", e);
    return false;
  });

  if (!updated) {
    redirect(
      `/${lang}/dashboard/account/email?status=emailUpdateFailed`,
      RedirectType.replace,
    );
  }

  let stripeCustomerEmailSync = "failed";
  try {
    stripeCustomerEmailSync = (
      await updateCustomerEmailIfExist({
        userId: tokenData.userId,
        email: tokenData.identifier,
      })
    ).status;
  } catch (error) {
    // The local email is already committed. Keep that successful update and
    // expose the secondary-sync failure to logs/audit; future billing entry
    // points retry the same idempotent customer email synchronization.
    console.error("Stripe customer email synchronization failed", {
      userId: tokenData.userId,
      error,
    });
  }

  await addAuditLog({
    userId: tokenData.userId,
    action: auditLogActions.account.emailChanged,
    details: `email: ${tokenData.identifier}, stripeCustomerEmailSync: ${stripeCustomerEmailSync}`,
  });
  revalidatePath(`/${lang}/dashboard/account/email`);
  redirect(
    `/${lang}/dashboard/account/email?status=emailUpdated`,
    RedirectType.replace,
  );
}
