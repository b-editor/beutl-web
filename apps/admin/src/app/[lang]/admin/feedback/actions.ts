"use server";

import { addAuditLog, auditLogActions } from "@/lib/audit-log";
import type { ActionResult } from "@beutl/core";
import { authenticated } from "@/lib/auth-guard";
import { isAdmin } from "@beutl/core";
import { updateFeedbackStatus } from "@beutl/db";
import type { FeedbackStatus } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { getLanguage } from "@/lib/lang-utils";

export async function updateStatus({
  id,
  status,
}: {
  id: string;
  status: FeedbackStatus;
}): Promise<ActionResult> {
  return await authenticated(async (session) => {
    if (!isAdmin(session.user.id)) {
      return { success: false, message: "Forbidden" };
    }

    await updateFeedbackStatus({ id, status });
    await addAuditLog({
      userId: session.user.id,
      action: auditLogActions.admin.feedbackStatusChanged,
      details: `feedbackId: ${id}, status: ${status}`,
    });
    const lang = await getLanguage();
    revalidatePath(`/${lang}/admin/feedback`);

    return { success: true };
  });
}
