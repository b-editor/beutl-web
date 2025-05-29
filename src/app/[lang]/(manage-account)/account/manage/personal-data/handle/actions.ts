import "server-only";
import { createHash } from "@/lib/create-hash";
import { prisma } from "@/prisma";
import { ConfirmationTokenPurpose } from "@prisma/client";
import { deleteUserById } from "@/lib/db/user";
import { addAuditLog, auditLogActions } from "@/lib/audit-log";

export async function deleteUser(token: string, identifier: string) {
  const secret = process.env.AUTH_SECRET;
  const hash = await createHash(`${token}${secret}`);
  const db = await prisma();
  const tokenData = await db.confirmationToken.delete({
    where: {
      identifier_token: {
        identifier: identifier,
        token: hash,
      },
    },
    select: {
      identifier: true,
      expires: true,
      userId: true,
      purpose: true,
    },
  });
  if (
    !tokenData ||
    tokenData.purpose !== ConfirmationTokenPurpose.ACCOUNT_DELETE
  ) {
    throw new Error("Invalid token");
  }

  if (tokenData.expires.valueOf() < Date.now()) {
    throw new Error("Token has expired");
  }

  await deleteUserById({ userId: tokenData.userId });
  await addAuditLog({
    userId: null,
    action: auditLogActions.account.accountDeleted,
    details: `User ${tokenData.userId} deleted their account`,
  });
}
