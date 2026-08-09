"use server";

import { addAuditLog, auditLogActions } from "@/lib/audit-log";
import type { ActionResult } from "@beutl/core";
import { authenticated } from "@/lib/auth-guard";
import { isAdmin } from "@beutl/core";
import { deleteUserById } from "@beutl/db";
import { revalidatePath } from "next/cache";
import { getLanguage } from "@/lib/lang-utils";

export async function deleteUser({
  userId,
}: {
  userId: string;
}): Promise<ActionResult> {
  return await authenticated(async (session) => {
    if (!isAdmin(session.user.id)) {
      return { success: false, message: "Forbidden" };
    }
    if (userId === session.user.id) {
      return { success: false, message: "You cannot delete your own account" };
    }

    await deleteUserById({ userId });
    await addAuditLog({
      userId: session.user.id,
      action: auditLogActions.admin.userDeleted,
      details: `userId: ${userId}`,
    });
    const lang = await getLanguage();
    revalidatePath(`/${lang}/admin/users`);

    return { success: true };
  });
}
