"use server";

import { addAuditLog, auditLogActions } from "@beutl/next/audit-log";
import type { ActionResult } from "@beutl/core";
import { adminAction } from "@/lib/auth-guard";
import { isAdmin } from "@beutl/core";
import { deleteUserById, startRetryableTransaction } from "@beutl/db";
import { revalidatePath } from "next/cache";

export async function deleteUser({
  userId,
}: {
  userId: string;
}): Promise<ActionResult> {
  return await adminAction(async (session) => {
    // Server Action の引数は型注釈が実行時に消えるため、値を検証してから永続化する。
    if (typeof userId !== "string" || userId.length === 0) {
      return { success: false, message: "Invalid user id" };
    }
    if (userId === session.user.id) {
      return { success: false, message: "You cannot delete your own account" };
    }
    if (isAdmin(userId)) {
      return {
        success: false,
        message: "You cannot delete an administrator account",
      };
    }

    // 監査ログと対象の書き込みは同一トランザクションで確定させる
    // (片方だけ成功すると、呼び出し元へ返す結果と実際の状態が食い違う)。
    // ユーザー削除は 10 テーブル以上へカスケードするため、CockroachDB の
    // SERIALIZABLE では書き込み競合 (P2034) で落ちやすい。再試行版を使う。
    await startRetryableTransaction(async (tx) => {
      await deleteUserById({ userId, prisma: tx });
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.admin.userDeleted,
        details: `userId: ${userId}`,
        prisma: tx,
      });
    });
    // middleware が既定ロケールを rewrite するため、リクエストのパスから描画時のロケールを特定できない。
    // ルートパターンを指定して、全ロケールのキャッシュをまとめて破棄する。
    revalidatePath("/[lang]/admin/users", "page");
    revalidatePath("/[lang]/admin/users/[id]", "page");

    return { success: true };
  });
}
