"use server";

import { addAuditLog, auditLogActions } from "@beutl/next/audit-log";
import type { ActionResult } from "@beutl/core";
import { authenticated } from "@/lib/auth-guard";
import { isAdmin } from "@beutl/core";
import { isFeedbackStatus, updateFeedbackStatus } from "@beutl/db";
import type { FeedbackStatus } from "@beutl/db";
import { revalidatePath } from "next/cache";

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

    // Server Action の引数は型注釈が実行時に消えるため、値を検証してから永続化する。
    if (!isFeedbackStatus(status)) {
      return { success: false, message: "Invalid status" };
    }
    if (typeof id !== "string" || id.length === 0) {
      return { success: false, message: "Invalid feedback id" };
    }

    await updateFeedbackStatus({ id, status });
    await addAuditLog({
      userId: session.user.id,
      action: auditLogActions.admin.feedbackStatusChanged,
      details: `feedbackId: ${id}, status: ${status}`,
    });
    // middleware が既定ロケールを rewrite するため、リクエストのパスから描画時のロケールを特定できない。
    // ルートパターンを指定して、全ロケールのキャッシュをまとめて破棄する。
    revalidatePath("/[lang]/admin/feedback", "page");

    return { success: true };
  });
}
