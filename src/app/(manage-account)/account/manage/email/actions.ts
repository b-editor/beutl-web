"use server";

import { createTransport } from "nodemailer";
import authOrSignIn from "@/lib/auth-guard";
import { prisma } from "@/prisma";
import { headers } from "next/headers";
import { z } from "zod";
import { options as nodemailerOptions } from "@/nodemailer";
import { redirect, RedirectType } from "next/navigation";
import { auth, signIn } from "@/auth";
import { revalidatePath } from "next/cache";
import { ConfirmationTokenPurpose } from "@prisma/client";

type State = {
  message?: string;
  success?: boolean;
}

const emailSchema = z.object({
  newEmail: z.string().email("メールアドレスが正しくありません"),
});

async function sendEmail(email: string, token: string) {
  const urlstr = headers().get("x-url");
  if (!urlstr) {
    throw new Error("URL is missing in headers");
  }
  const url = new URL(urlstr);
  url.pathname = "/account/manage/email";
  url.searchParams.forEach((_, key) => url.searchParams.delete(key));
  url.searchParams.set("token", token);
  url.searchParams.set("identifier", email);
  // nodemailerを使ってメールを送信する
  const transport = createTransport(nodemailerOptions.server)
  const result = await transport.sendMail({
    to: email,
    from: nodemailerOptions.from,
    subject: "メールアドレスの変更",
    html: `
      <p>以下のリンクをクリックしてメールアドレスを変更してください。</p>
      <a href="${url.toString()}">メールアドレスを変更</a>
    `,
  })
  const failed = result.rejected.concat(result.pending).filter(Boolean)
  if (failed.length) {
    throw new Error(`Email (${failed.join(", ")}) could not be sent`)
  }
}

function randomString(size: number) {
  const i2hex = (i: number) => (`0${i.toString(16)}`).slice(-2)
  const r = (a: string, i: number): string => a + i2hex(i)
  const bytes = crypto.getRandomValues(new Uint8Array(size))
  return Array.from(bytes).reduce(r, "")
}

export async function createHash(message: string) {
  const data = new TextEncoder().encode(message)
  const hash = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toString()
}

export async function sendConfirmationEmail(state: State, formData: FormData): Promise<State> {
  const session = await authOrSignIn();
  const validated = emailSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!validated.success) {
    return {
      message: "入力内容に誤りがあります",
      success: false,
    };
  }

  // メールアドレス更新
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
    message: "メールアドレスを変更するためのリンクを送信しました",
    success: true,
  };
}

export async function updateEmail(token: string, identifier: string) {
  const secret = process.env.AUTH_SECRET;
  const hash = await createHash(`${token}${secret}`)
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
    throw new Error("トークンが無効です");
  }

  if (tokenData.expires.valueOf() < Date.now()) {
    throw new Error("トークンの有効期限が切れています");
  }

  const updated = await prisma.user.update({
    where: {
      id: tokenData.userId,
    },
    data: {
      email: tokenData.identifier,
    },
  });
  if (!updated) {
    throw new Error("メールアドレスを更新できませんでした");
  }

  revalidatePath("/account/manage/email");
  redirect("/account/manage/email?emailUpdated=true", RedirectType.replace);
}