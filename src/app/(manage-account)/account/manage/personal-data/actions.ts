"use server";

import { createTransport } from "nodemailer";
import authOrSignIn from "@/lib/auth-guard";
import { prisma } from "@/prisma";
import { headers } from "next/headers";
import { z } from "zod";
import { options as nodemailerOptions } from "@/nodemailer";
import { ConfirmationTokenPurpose } from "@prisma/client";
import { createHash, randomString } from "@/lib/create-hash";
import { revalidatePath } from "next/cache";

type State = {
  message?: string;
  success?: boolean;
}

const emptyStringToUndefined = z.literal('').transform(() => undefined);
const emailSchema = z.object({
  cancel: z.literal("true").optional().or(emptyStringToUndefined),
});

async function sendEmail(email: string, token: string) {
  const urlstr = headers().get("x-url");
  if (!urlstr) {
    throw new Error("URL is missing in headers");
  }
  const url = new URL(urlstr);
  url.pathname = "/account/manage/personal-data/handle";
  url.searchParams.forEach((_, key) => url.searchParams.delete(key));
  url.searchParams.set("token", token);
  url.searchParams.set("identifier", email);
  // nodemailerを使ってメールを送信する
  const transport = createTransport(nodemailerOptions.server)
  const result = await transport.sendMail({
    to: email,
    from: nodemailerOptions.from,
    subject: "アカウント削除の確認",
    html: `
      <p>以下のリンクをクリックしてアカウントを削除できます</p>
      <a href="${url.toString()}">アカウントを削除</a>
    `,
  })
  const failed = result.rejected.concat(result.pending).filter(Boolean)
  if (failed.length) {
    throw new Error(`Email (${failed.join(", ")}) could not be sent`)
  }
}

export async function submit(state: State, formData: FormData): Promise<State> {
  const session = await authOrSignIn();
  const validated = emailSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!validated.success) {
    console.error(validated.error);
    return {
      message: "入力内容に誤りがあります",
      success: false,
    };
  }

  if (validated.data.cancel) {
    await prisma.confirmationToken.deleteMany({
      where: {
        userId: session.user.id,
        purpose: ConfirmationTokenPurpose.ACCOUNT_DELETE,
      }
    });
    revalidatePath("/account/manage/personal-data");
    return {
      message: "アカウント削除をキャンセルしました",
      success: true,
    };
  }
  
  const user = await prisma.user.findFirst({
    where: {
      id: session.user.id,
    },
    select: {
      email: true,
    }
  });
  if (!user) {
    throw new Error("User not found");
  }
  const maxAge = 24 * 60 * 60;
  const ONE_DAY_IN_SECONDS = 86400
  const expires = new Date(
    Date.now() + (maxAge ?? ONE_DAY_IN_SECONDS) * 1000
  )
  const secret = process.env.AUTH_SECRET;
  const token = randomString(32);
  const sendRequest = sendEmail(user.email, token);
  const createToken = prisma.confirmationToken.create({
    data: {
      token: await createHash(`${token}${secret}`),
      identifier: user.email,
      userId: session.user.id,
      expires,
      purpose: ConfirmationTokenPurpose.ACCOUNT_DELETE
    },
  });

  await Promise.all([sendRequest, createToken]);

  revalidatePath("/account/manage/personal-data");
  return {
    message: "アカウントを削除するためのリンクを送信しました",
    success: true,
  };
}
