"use server";

import { createHash } from "@/lib/create-hash";
import { prisma } from "@/prisma";
import { ConfirmationTokenPurpose } from "@prisma/client";

export async function deleteUser(token: string, identifier: string) {
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
    },
  });
  if (!tokenData || tokenData.purpose !== ConfirmationTokenPurpose.ACCOUNT_DELETE) {
    throw new Error("トークンが無効です");
  }

  if (tokenData.expires.valueOf() < Date.now()) {
    throw new Error("トークンの有効期限が切れています");
  }

  await prisma.user.delete({
    where: {
      id: tokenData.userId,
    }
  });
}
