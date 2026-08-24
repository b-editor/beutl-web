"use server";

import { addAuditLog, auditLogActions } from "@beutl/next/audit-log";
import type { ActionResult } from "@beutl/core";
import { adminAction } from "@/lib/auth-guard";
import { isAdmin } from "@beutl/core";
import {
  adjustPurchasedCreditsByAdmin,
  CreditAdjustmentRejectedError,
  deleteUserById,
  enqueueUserStorageCleanups,
  existsUserById,
  findAdminCreditAdjustment,
  getSubscriptionByUserId,
  isUniqueConstraintViolation,
  prepareAccountDeletionOutboxes,
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

    // 課金の続いている相手は消せない。この画面から Stripe の解約はできず、
    // 行だけ消すと請求はそのまま続き、こちらには誰の請求なのかを引く手掛かりが
    // 残らない——webhook も、対応する行が無いものは黙って受け取る。
    const subscription = await getSubscriptionByUserId({ userId });
    if (subscription && isActiveProSubscription(subscription)) {
      return {
        success: false,
        message:
          "Cancel this user's Pro subscription before deleting the account",
      };
    }

    // 監査ログと対象の書き込みは同一トランザクションで確定させる
    // (片方だけ成功すると、呼び出し元へ返す結果と実際の状態が食い違う)。
    // ユーザー削除は 10 テーブル以上へカスケードするため、CockroachDB の
    // SERIALIZABLE では書き込み競合 (P2034) で落ちやすい。再試行版を使う。
    await startRetryableTransaction(async (tx) => {
      // 本人が消すときと同じ後始末を、同じトランザクションで。行が消えたあとに
      // 外の持ちものを指す手掛かりは残らないので、消す前に控えを取る——R2 の
      // オブジェクトと、走っている provider の job がそれ。
      await enqueueUserStorageCleanups({ userId, prisma: tx });
      await prepareAccountDeletionOutboxes({ userId, prisma: tx });
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
  adjustmentKey,
}: {
  userId: string;
  creditDelta: number;
  // 一回の操作を表すキー。確定の二度押しや Server Action の再送が同じ付与を
  // 二回適用しないよう、画面が確認ダイアログを開いた時点で発行する。
  adjustmentKey: string;
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
    if (
      typeof adjustmentKey !== "string" ||
      !/^[0-9a-f-]{36}$/u.test(adjustmentKey)
    ) {
      return { success: false, message: "Invalid adjustment key" };
    }

    try {
      const result = await startRetryableTransaction(async (tx) => {
        // 削除済みユーザーに対する調整は台帳へ孤立した行を残すだけなので、
        // 先に存在を確かめる。
        if (!(await existsUserById({ id: userId, prisma: tx }))) {
          return { success: false as const, message: "User not found" };
        }
        // 同じキーの再送は台帳を動かさない。監査ログは価値を動かした操作の
        // 記録なので、再送のたびに追記すると一度の付与が複数回に見える。
        const alreadyApplied = await findAdminCreditAdjustment({
          adjustmentKey,
          prisma: tx,
        });
        const account = await adjustPurchasedCreditsByAdmin({
          userId,
          creditDelta,
          adjustmentKey,
          prisma: tx,
        });
        if (!alreadyApplied) {
          await addAuditLog({
            userId: session.user.id,
            action: auditLogActions.admin.aiCreditsAdjusted,
            details: `userId: ${userId}, creditDelta: ${creditDelta}, purchasedCredits: ${account.purchasedCredits}, purchasedCreditDebt: ${account.purchasedCreditDebt}`,
            prisma: tx,
          });
        }
        return { success: true as const };
      });
      if (!result.success) {
        return result;
      }
    } catch (e) {
      if (e instanceof CreditAdjustmentRejectedError) {
        return { success: false, message: e.message };
      }
      // 同じキーの送信が二つ重なると、adminAdjustmentKey の一意インデックスが
      // 後から挿入する側を弾く。付与自体は勝った側が適用済みなので、失敗として
      // 返すと操作者が入力し直して二重に付与してしまう。
      if (!isUniqueConstraintViolation(e)) {
        throw e;
      }
      // ただし「弾かれた」ことは「同じ調整が適用された」ことを意味しない。
      // 勝った側の内容を読み直して確かめる。金額や対象が違えば別の決定であり、
      // 一意制約に当たったという理由だけで成功と答えてはいけない。
      try {
        await startRetryableTransaction(
          async (tx) =>
            await adjustPurchasedCreditsByAdmin({
              userId,
              creditDelta,
              adjustmentKey,
              prisma: tx,
            }),
        );
      } catch (verification) {
        if (verification instanceof CreditAdjustmentRejectedError) {
          return { success: false, message: verification.message };
        }
        throw verification;
      }
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
  expectedMonthlyUsageUsed,
}: {
  userId: string;
  monthlyUsageUsed: number;
  // 画面が表示していた値。適用の直前に消費が動いていたら、絶対値の書き込みが
  // それを黙って打ち消すため、その場合は拒否して読み直させる。
  expectedMonthlyUsageUsed: number;
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
    if (
      typeof expectedMonthlyUsageUsed !== "number" ||
      !Number.isSafeInteger(expectedMonthlyUsageUsed) ||
      expectedMonthlyUsageUsed < 0
    ) {
      return { success: false, message: "Invalid expected usage amount" };
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
          expectedMonthlyUsageUsed,
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
