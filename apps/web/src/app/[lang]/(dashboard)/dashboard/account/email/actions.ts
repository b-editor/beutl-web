"use server";

import { authenticated, getAuthoritativeSession } from "@/lib/auth-guard";
import { headers } from "next/headers";
import { emailButton, sendEmail as sendEmailUsingResend } from "@beutl/email";
import { redirect, RedirectType } from "next/navigation";
import { revalidatePath } from "next/cache";
import { ConfirmationTokenPurpose } from "@prisma/client";
import { getTranslation, type Zod } from "@beutl/i18n";
import { getLanguage } from "@beutl/next/language";
import { existsUserByEmail, updateUserEmail } from "@beutl/db";
import { isAuthEmailRateLimitError, limitAuthEmailSend } from "@beutl/next/auth-email-rate-limit";
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

async function sendEmail(email: string, token: string, newEmail: string, approval = false) {
  const lang = await getLanguage();
  const { t } = await getTranslation(lang);
  const url = new URL(
    `/${lang}/dashboard/account/email/confirm`,
    process.env.BETTER_AUTH_URL || "http://localhost:3000",
  );
  url.searchParams.set("token", token);
  url.searchParams.set("identifier", newEmail);
  if (approval) url.searchParams.set("approval", "1");
  await sendEmailUsingResend({
    to: email,
    subject: t("account:email.changeEmail"),
    body: `
      <p>${approval ? t("account:email.approveChange", { email: newEmail }) : t("account:email.clickOnTheLink")}</p>
      ${emailButton(url.toString(), t("change"))}
    `,
    lang,
  });
}

export async function sendConfirmationEmail(state: State, formData: FormData): Promise<State> {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t, z } = await getTranslation(lang);
    const validated = emailSchema(z).safeParse(Object.fromEntries(formData.entries()));
    if (!validated.success) {
      return {
        message: validated.error.issues[0]?.message ?? t("invalidRequest"),
        success: false,
      };
    }
    // Match Better Auth's mailbox identity normalization.
    const newEmail = validated.data.newEmail.toLowerCase();

    if (await existsUserByEmail({ email: newEmail })) {
      return {
        message: t("account:email.emailExists"),
        success: false,
      };
    }
    try {
      await limitAuthEmailSend(session.user.email, await headers());
    } catch (error) {
      if (isAuthEmailRateLimitError(error))
        return { success: false, message: t("auth:errors.emailRateLimited") };
      throw error;
    }
    const token = await issueConfirmationToken({
      identifier: newEmail,
      userId: session.user.id,
      purpose: ConfirmationTokenPurpose.EMAIL_UPDATE_APPROVAL,
      sessionId: session.session.id,
      sourceEmail: session.user.email,
    });
    const sendRequest = sendEmail(session.user.email, token, newEmail, true);

    await Promise.all([sendRequest]);
    await addAuditLog({
      userId: session.user.id,
      action: auditLogActions.account.sentEmailChangeConfirmation,
      details: `email: ${newEmail}`,
    });
    return {
      message: t("account:email.approvalSent"),
      success: true,
    };
  }, true);
}

/** Possession of the current mailbox is required before the new mailbox is contacted. */
export async function approveEmailChange(token: string, identifier: string) {
  const lang = await getLanguage();
  const fail = (): never =>
    redirect(`/${lang}/dashboard/account/email?status=emailUpdateFailed`, RedirectType.replace);
  const session = await getAuthoritativeSession();
  if (!session?.user?.id) return fail();
  const result = await validateConfirmationToken({
    token,
    identifier,
    purpose: ConfirmationTokenPurpose.EMAIL_UPDATE_APPROVAL,
  });
  if (!result.valid || result.tokenData.userId !== session.user.id) return fail();
  try {
    await limitAuthEmailSend(result.tokenData.identifier, await headers());
  } catch (error) {
    if (isAuthEmailRateLimitError(error))
      redirect(`/${lang}/dashboard/account/email?status=emailRateLimited`, RedirectType.replace);
    throw error;
  }
  const nextToken = await startTransaction(async (prisma) => {
    const consumed = await consumeConfirmationToken({
      token,
      identifier,
      purpose: ConfirmationTokenPurpose.EMAIL_UPDATE_APPROVAL,
      authorizedUserId: session.user.id,
      authorizedSessionId: session.session.id,
      prisma,
    });
    if (!consumed.valid) return null;
    return await issueConfirmationToken({
      identifier,
      userId: consumed.tokenData.userId,
      purpose: ConfirmationTokenPurpose.EMAIL_UPDATE,
      sessionId: consumed.tokenData.sessionId!,
      sourceEmail: consumed.tokenData.sourceEmail!,
      prisma,
    });
  });
  if (!nextToken) return fail();
  await sendEmail(identifier, nextToken, identifier);
  redirect(`/${lang}/dashboard/account/email?status=emailVerificationSent`, RedirectType.replace);
}

export async function updateEmail(token: string, identifier: string) {
  const lang = await getLanguage();
  const session = await getAuthoritativeSession();
  if (!session?.user?.id) {
    redirect(`/${lang}/dashboard/account/email?status=emailUpdateFailed`, RedirectType.replace);
  }
  const result = await validateConfirmationToken({
    token,
    identifier,
    purpose: ConfirmationTokenPurpose.EMAIL_UPDATE,
  });
  if (!result.valid || result.tokenData.userId !== session.user.id) {
    console.error(
      !result.valid && result.reason === "expired" ? "Token has expired" : "Invalid token",
    );
    redirect(`/${lang}/dashboard/account/email?status=emailUpdateFailed`, RedirectType.replace);
  }
  const { tokenData } = result;

  const updated = await startTransaction(async (p) => {
    const consumed = await consumeConfirmationToken({
      token,
      identifier,
      purpose: ConfirmationTokenPurpose.EMAIL_UPDATE,
      authorizedUserId: session.user.id,
      authorizedSessionId: session.session.id,
      prisma: p,
    });
    if (!consumed.valid || consumed.tokenData.userId !== tokenData.userId) {
      return false;
    }
    await updateUserEmail({
      userId: tokenData.userId,
      email: tokenData.identifier,
      expectedEmail: tokenData.sourceEmail!,
      prisma: p,
    });
    return true;
  }).catch((e) => {
    console.error("Failed to update email", e);
    return false;
  });

  if (!updated) {
    redirect(`/${lang}/dashboard/account/email?status=emailUpdateFailed`, RedirectType.replace);
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
  redirect(`/${lang}/dashboard/account/email?status=emailUpdated`, RedirectType.replace);
}
