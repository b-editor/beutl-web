"use server";

import { authenticated } from "@/lib/auth-guard";
import { drizzle } from "@/drizzle";
import { headers } from "next/headers";
import { sendEmail as sendEmailUsingResend } from "@/resend";
import { redirect, RedirectType } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createHash, randomString } from "@/lib/create-hash";
import { getTranslation, type Zod } from "@/app/i18n/server";
import { getLanguage } from "@/lib/lang-utils";
import {
  existsUserByEmail,
  existsUserById,
  updateUserEmail,
} from "@/lib/db/user";
import { updateCustomerEmailIfExist } from "@/lib/db/customer";
import { addAuditLog, auditLogActions } from "@/lib/audit-log";
import { confirmationToken } from "@/drizzle/schema";
import { and, count, eq } from "drizzle-orm";

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
  url.pathname = `/${lang}/account/manage/email`;
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
        message: t("zod:errors.invalid_string.email", {
          validation: t("zod:validations.email"),
        }),
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
    const maxAge = 24 * 60 * 60;
    const ONE_DAY_IN_SECONDS = 86400;
    const expires = new Date(
      Date.now() + (maxAge ?? ONE_DAY_IN_SECONDS) * 1000,
    );
    const secret = process.env.AUTH_SECRET;
    const token = randomString(32);
    const sendRequest = sendEmail(validated.data.newEmail, token);
    const db = await drizzle();
    const createToken = db.insert(confirmationToken).values({
      token: await createHash(`${token}${secret}`),
      identifier: validated.data.newEmail,
      userId: session.user.id,
      expires,
      purpose: 'EMAIL_UPDATE',
    });

    await Promise.all([sendRequest, createToken]);
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
  const secret = process.env.AUTH_SECRET;
  const hash = await createHash(`${token}${secret}`);
  const db = await drizzle();
  const [{ cnt }] = await db.select({ cnt: count() })
    .from(confirmationToken)
    .where(and(
      eq(confirmationToken.identifier, identifier),
      eq(confirmationToken.token, hash),
    ));
  if (cnt === 0) {
    console.error("Invalid token");
    redirect(
      `/${lang}/account/manage/email?status=emailUpdateFailed`,
      RedirectType.replace,
    );
  }

  const tokenData = await db.delete(confirmationToken)
    .where(
      and(
        eq(confirmationToken.identifier, identifier),
        eq(confirmationToken.token, hash),
      ),
    )
    .returning({
      identifier: confirmationToken.identifier,
      expires: confirmationToken.expires,
      userId: confirmationToken.userId,
      purpose: confirmationToken.purpose,
    })
    .then((rows) => rows.at(0));
  if (
    !tokenData ||
    tokenData.purpose !== 'EMAIL_UPDATE'
  ) {
    console.error("Invalid token");
    redirect(
      `/${lang}/account/manage/email?status=emailUpdateFailed`,
      RedirectType.replace,
    );
  }

  if (tokenData.expires.valueOf() < Date.now()) {
    console.error("Token has expired");
    redirect(
      `/${lang}/account/manage/email?status=emailUpdateFailed`,
      RedirectType.replace,
    );
  }


  const updated = await db.transaction(async (p) => {
    await updateUserEmail({
      userId: tokenData.userId,
      email: tokenData.identifier,
      transaction: p,
    });

    await updateCustomerEmailIfExist({
      userId: tokenData.userId,
      email: tokenData.identifier,
      transaction: p,
    });
    return true;
  }).catch((e) => {
    console.error("Failed to update email", e);
    return false;
  });

  if (!updated) {
    redirect(
      `/${lang}/account/manage/email?status=emailUpdateFailed`,
      RedirectType.replace,
    );
  }

  await addAuditLog({
    userId: tokenData.userId,
    action: auditLogActions.account.emailChanged,
    details: `email: ${tokenData.identifier}`,
  });
  revalidatePath(`/${lang}/account/manage/email`);
  redirect(
    `/${lang}/account/manage/email?status=emailUpdated`,
    RedirectType.replace,
  );
}
