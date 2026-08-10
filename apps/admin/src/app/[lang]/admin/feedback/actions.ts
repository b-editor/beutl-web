"use server";

import { addAuditLog, auditLogActions } from "@beutl/next/audit-log";
import type { ActionResult } from "@beutl/core";
import { adminAction } from "@/lib/auth-guard";
import { isFeedbackStatus, startTransaction, updateFeedbackStatus } from "@beutl/db";
import type { FeedbackStatus } from "@beutl/db";
import { revalidatePath } from "next/cache";

export async function updateStatus({
  id,
  status,
}: {
  id: string;
  status: FeedbackStatus;
}): Promise<ActionResult> {
  return await adminAction(async (session) => {
    // Server Action の引数は型注釈が実行時に消えるため、値を検証してから永続化する。
    if (!isFeedbackStatus(status)) {
      return { success: false, message: "Invalid status" };
    }
    if (typeof id !== "string" || id.length === 0) {
      return { success: false, message: "Invalid feedback id" };
    }

    // 監査ログと対象の書き込みは同一トランザクションで確定させる
    // (片方だけ成功すると、呼び出し元へ返す結果と実際の状態が食い違う)。
    await startTransaction(async (tx) => {
      await updateFeedbackStatus({ id, status, prisma: tx });
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.admin.feedbackStatusChanged,
        details: `feedbackId: ${id}, status: ${status}`,
        prisma: tx,
      });
    });
    // middleware が既定ロケールを rewrite するため、リクエストのパスから描画時のロケールを特定できない。
    // ルートパターンを指定して、全ロケールのキャッシュをまとめて破棄する。
    revalidatePath("/[lang]/admin/feedback", "page");

    return { success: true };
  });
}
