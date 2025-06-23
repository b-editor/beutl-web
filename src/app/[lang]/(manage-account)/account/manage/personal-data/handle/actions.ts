import "server-only";
import { createHash } from "@/lib/create-hash";
import { drizzle } from "@/drizzle";
import { confirmationToken } from "@/drizzle/schema";
import { and, eq } from "drizzle-orm";
import { deleteUserById } from "@/lib/db/user";
import { addAuditLog, auditLogActions } from "@/lib/audit-log";

export async function deleteUser(token: string, identifier: string) {
  const secret = process.env.AUTH_SECRET;
  const hash = await createHash(`${token}${secret}`);
  const db = await drizzle();
  
  // First select the token data
  const tokenData = await db
    .select()
    .from(confirmationToken)
    .where(
      and(
        eq(confirmationToken.identifier, identifier),
        eq(confirmationToken.token, hash)
      )
    )
    .limit(1)
    .then(rows => rows[0]);
  
  // Then delete it if found
  if (tokenData) {
    await db
      .delete(confirmationToken)
      .where(
        and(
          eq(confirmationToken.identifier, identifier),
          eq(confirmationToken.token, hash)
        )
      );
  }
  if (
    !tokenData ||
    tokenData.purpose !== 'ACCOUNT_DELETE'
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
