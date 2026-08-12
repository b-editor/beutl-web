import "server-only";
import { ConfirmationTokenPurpose } from "@prisma/client";
import { deleteUserById } from "@beutl/db";
import { addAuditLog, auditLogActions } from "@beutl/next/audit-log";
import { consumeConfirmationToken } from "@/lib/confirmation-token-flow";
import { drainStorageCleanup } from "@/lib/storage";

export async function deleteUser(token: string, identifier: string) {
  const result = await consumeConfirmationToken({
    token,
    identifier,
    purpose: ConfirmationTokenPurpose.ACCOUNT_DELETE,
  });

  if (!result.valid) {
    if (result.reason === "expired") {
      throw new Error("Token has expired");
    }
    throw new Error("Invalid token");
  }
  const { tokenData } = result;

  await deleteUserById({ userId: tokenData.userId });
  await drainStorageCleanup();
  await addAuditLog({
    userId: null,
    action: auditLogActions.account.accountDeleted,
    details: `User ${tokenData.userId} deleted their account`,
  });
}
