"use server";

import { addAuditLog, auditLogActions } from "@beutl/next/audit-log";
import type { ActionResult } from "@beutl/core";
import { adminAction } from "@/lib/auth-guard";
import { isAdmin } from "@beutl/core";
import {
  adjustPurchasedCreditsByAdmin,
  CreditAdjustmentRejectedError,
  deleteUserById,
  existsUserById,
  getSubscriptionByUserId,
  setMonthlyUsageUsedByAdmin,
  startRetryableTransaction,
} from "@beutl/db";
import { isActiveProSubscription, loadAiSettings } from "@beutl/api";
import { revalidatePath } from "next/cache";

// A typo of one order of magnitude must not hand out a fortune. Larger
// corrections are still possible by repeating the adjustment.
const MAX_CREDIT_ADJUSTMENT = 100_000;

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

// 追加クレジットの手動増減。付与は購入と同じく債務の返済を優先し、
// 回収は残高を超えると拒否する (手動操作で債務を作らない)。
export async function adjustAiCredits({
  userId,
  creditDelta,
}: {
  userId: string;
  creditDelta: number;
}): Promise<ActionResult> {
  return await adminAction(async (session) => {
    // Server Action の引数は型注釈が実行時に消えるため、値域をここで検証する。
    if (typeof userId !== "string" || userId.length === 0) {
      return { success: false, message: "Invalid user id" };
    }
    if (
      typeof creditDelta !== "number" ||
      !Number.isSafeInteger(creditDelta) ||
      creditDelta === 0 ||
      Math.abs(creditDelta) > MAX_CREDIT_ADJUSTMENT
    ) {
      return { success: false, message: "Invalid credit amount" };
    }

    try {
      const result = await startRetryableTransaction(async (tx) => {
        // 削除済みユーザーに対する調整は台帳へ孤立した行を残すだけなので、
        // 先に存在を確かめる。
        if (!(await existsUserById({ id: userId, prisma: tx }))) {
          return { success: false as const, message: "User not found" };
        }
        const account = await adjustPurchasedCreditsByAdmin({
          userId,
          creditDelta,
          prisma: tx,
        });
        await addAuditLog({
          userId: session.user.id,
          action: auditLogActions.admin.aiCreditsAdjusted,
          details: `userId: ${userId}, creditDelta: ${creditDelta}, purchasedCredits: ${account.purchasedCredits}, purchasedCreditDebt: ${account.purchasedCreditDebt}`,
          prisma: tx,
        });
        return { success: true as const };
      });
      if (!result.success) {
        return result;
      }
    } catch (e) {
      if (e instanceof CreditAdjustmentRejectedError) {
        return { success: false, message: e.message };
      }
      throw e;
    }
    revalidatePath("/[lang]/admin/users/[id]", "page");

    return { success: true };
  });
}

// 月間割当の消費量を絶対値で設定する。割当は Pro 契約の請求期間に紐づくため、
// 契約が有効なユーザーだけを対象にする。
export async function setAiMonthlyUsage({
  userId,
  monthlyUsageUsed,
}: {
  userId: string;
  monthlyUsageUsed: number;
}): Promise<ActionResult> {
  return await adminAction(async (session) => {
    if (typeof userId !== "string" || userId.length === 0) {
      return { success: false, message: "Invalid user id" };
    }
    if (
      typeof monthlyUsageUsed !== "number" ||
      !Number.isSafeInteger(monthlyUsageUsed) ||
      monthlyUsageUsed < 0
    ) {
      return { success: false, message: "Invalid usage amount" };
    }

    try {
      const result = await startRetryableTransaction(async (tx) => {
        const subscription = await getSubscriptionByUserId({
          userId,
          prisma: tx,
        });
        if (!subscription || !isActiveProSubscription(subscription)) {
          return {
            success: false as const,
            message: "The user has no active AI plan",
          };
        }
        const settings = await loadAiSettings({ prisma: tx });
        const monthlyUsageLimit = settings.getMonthlyUsageLimit();
        if (monthlyUsageUsed > monthlyUsageLimit) {
          return {
            success: false as const,
            message: `The monthly allowance is ${monthlyUsageLimit} units`,
          };
        }

        await setMonthlyUsageUsedByAdmin({
          userId,
          monthlyUsageUsed,
          monthlyUsageLimit,
          usagePeriod: {
            start: subscription.currentPeriodStart,
            end: subscription.currentPeriodEnd,
          },
          prisma: tx,
        });
        await addAuditLog({
          userId: session.user.id,
          action: auditLogActions.admin.aiMonthlyUsageAdjusted,
          details: `userId: ${userId}, monthlyUsageUsed: ${monthlyUsageUsed}, monthlyUsageLimit: ${monthlyUsageLimit}`,
          prisma: tx,
        });
        return { success: true as const };
      });
      if (!result.success) {
        return result;
      }
    } catch (e) {
      if (e instanceof CreditAdjustmentRejectedError) {
        return { success: false, message: e.message };
      }
      throw e;
    }
    revalidatePath("/[lang]/admin/users/[id]", "page");

    return { success: true };
  });
}
