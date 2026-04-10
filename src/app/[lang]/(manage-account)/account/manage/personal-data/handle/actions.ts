import "server-only";
import { createHash } from "@/lib/create-hash";
import { getDbAsync } from "@/db";
import { confirmationToken } from "@/db/schema";
import { ConfirmationTokenPurpose } from "@/db/types";
import { and, eq } from "drizzle-orm";
import { deleteUserById } from "@/lib/db/user";
import { addAuditLog, auditLogActions } from "@/lib/audit-log";

export async function deleteUser(token: string, identifier: string) {
  const secret = process.env.AUTH_SECRET;
  const hash = await createHash(`${token}${secret}`);
  const db = await getDbAsync();
  const deletedRows = await db
    .delete(confirmationToken)
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
    });
  const tokenData = deletedRows[0];
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
