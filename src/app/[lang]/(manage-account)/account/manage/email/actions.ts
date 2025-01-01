"use server";

import { createTransport } from "nodemailer";
import { authenticated } from "@/lib/auth-guard";
import { prisma } from "@/prisma";
import { headers } from "next/headers";
import { options as nodemailerOptions, renderUnsafeEmailTemplate } from "@/nodemailer";
import { redirect, RedirectType } from "next/navigation";
import { revalidatePath } from "next/cache";
import { ConfirmationTokenPurpose } from "@prisma/client";
import { createHash, randomString } from "@/lib/create-hash";
import { getTranslation, type Zod } from "@/app/i18n/server";
import { getLanguage } from "@/lib/lang-utils";
import { createStripe } from "@/lib/stripe/config";
import { existsUserByEmail, existsUserById, updateUserEmail } from "@/lib/db/user";
import { updateCustomerEmailIfExist } from "@/lib/db/customer";
import { startTransaction } from "@/lib/db/transaction";

type State = {
  message?: string;
  success?: boolean;
}

const emailSchema = (z: Zod) => z.object({
  newEmail: z.string().email(),
});

async function sendEmail(email: string, token: string) {
  const lang = getLanguage();
  const { t } = await getTranslation(lang);
  const urlstr = headers().get("x-url");
  if (!urlstr) {
    throw new Error("URL is missing in headers");
  }
  const url = new URL(urlstr);
  url.pathname = `/${lang}/account/manage/email`;
  url.searchParams.forEach((_, key) => url.searchParams.delete(key));
  url.searchParams.set("token", token);
  url.searchParams.set("identifier", email);
  // nodemailerを使ってメールを送信する
  const transport = createTransport(nodemailerOptions.server)
  const result = await transport.sendMail({
    to: email,
    from: nodemailerOptions.from,
    subject: t("account:email.changeEmail"),
    html: renderUnsafeEmailTemplate(`
      <p>${t("account:email.clickOnTheLink")}</p>
      <a href="${url.toString()}">${t("change")}</a>
    `),
  })
  const failed = result.rejected.concat(result.pending).filter(Boolean)
  if (failed.length) {
    throw new Error(`Email (${failed.join(", ")}) could not be sent`)
  }
}

export async function sendConfirmationEmail(state: State, formData: FormData): Promise<State> {
  return await authenticated(async session => {
    const lang = getLanguage();
    const { t, z } = await getTranslation(lang);
    const validated = emailSchema(z).safeParse(Object.fromEntries(formData.entries()));
    if (!validated.success) {
      return {
        message: t("zod:errors.invalid_string.email", { validation: t("zod:validations.email") }),
        success: false,
      };
    }

    // メールアドレス更新
    if (!await existsUserById({ id: session.user.id })) {
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
    const ONE_DAY_IN_SECONDS = 86400
    const expires = new Date(
      Date.now() + (maxAge ?? ONE_DAY_IN_SECONDS) * 1000
    )
    const secret = process.env.AUTH_SECRET;
    const token = randomString(32);
    const sendRequest = sendEmail(validated.data.newEmail, token);
    const createToken = prisma.confirmationToken.create({
      data: {
        token: await createHash(`${token}${secret}`),
        identifier: validated.data.newEmail,
        userId: session.user.id,
        expires,
        purpose: ConfirmationTokenPurpose.EMAIL_UPDATE
      },
    });

    await Promise.all([sendRequest, createToken]);

    return {
      message: t("account:email.emailSent"),
      success: true,
    };
  });
}

export async function updateEmail(token: string, identifier: string) {
  const lang = getLanguage();
  const secret = process.env.AUTH_SECRET;
  const hash = await createHash(`${token}${secret}`);
  const tokenData = await prisma.confirmationToken.delete({
    where: {
      identifier_token: {
        identifier: identifier,
        token: hash,
      }
    },
    select: {
      identifier: true,
      expires: true,
      userId: true,
      purpose: true,
    }
  });
  if (!tokenData || tokenData.purpose !== ConfirmationTokenPurpose.EMAIL_UPDATE) {
    console.error("Invalid token");
    redirect(`/${lang}/account/manage/email?status=emailUpdateFailed`, RedirectType.replace);
  }

  if (tokenData.expires.valueOf() < Date.now()) {
    console.error("Token has expired");
    redirect(`/${lang}/account/manage/email?status=emailUpdateFailed`, RedirectType.replace);
  }

  const updated = await startTransaction(async (p) => {
    await updateUserEmail({
      userId: tokenData.userId,
      email: tokenData.identifier,
      prisma: p
    });

    await updateCustomerEmailIfExist({
      userId: tokenData.userId,
      email: tokenData.identifier,
      prisma: p
    });
    return true;
  }).catch((e) => {
    console.error("Failed to update email", e);
    return false;
  });

  if (!updated) {
    redirect(`/${lang}/account/manage/email?status=emailUpdateFailed`, RedirectType.replace);
  }

  revalidatePath(`/${lang}/account/manage/email`);
  redirect(`/${lang}/account/manage/email?status=emailUpdated`, RedirectType.replace);
}