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
  findAccountDeletionIntentByUserId,
  findCustomerByUserId,
  getSubscriptionByUserId,
  isUniqueConstraintViolation,
  prepareAccountDeletionOutboxes,
  reserveAdminAccountDeletion,
  setMonthlyUsageUsedByAdmin,
  startRetryableTransaction,
  resumeTopUpCheckoutIntervention,
  terminalizeTopUpCheckoutIntervention,
} from "@beutl/db";
import {
  closeStripeCustomerForAdminAccountDeletion,
  isActiveProSubscription,
  loadAiSettings,
} from "@beutl/api";
import { revalidatePath } from "next/cache";
import Stripe from "stripe";
import { claimPackageCheckoutInterventionById, reschedulePackageCheckoutIntervention } from "@beutl/db";
import { resolveLegacyPackageCheckoutMultiple } from "@beutl/api";

export async function resolvePackageCheckoutMultiple(input: unknown): Promise<ActionResult> {
  return await adminAction(async (session) => {
    if (!input || typeof input !== "object") return { success: false, message: "Invalid resolver input" };
    const value = input as Record<string, unknown>;
    const attemptId = value.attemptId;
    const discoveryToken = value.discoveryToken;
    const choice = value.choice;
    if (typeof attemptId !== "string" || typeof discoveryToken !== "string" || (choice !== "all-refund" && typeof choice !== "string")) return { success: false, message: "Invalid resolver input" };
    const leaseToken = crypto.randomUUID();
    const attempt = await claimPackageCheckoutInterventionById({ id: attemptId, discoveryToken, now: new Date(), leaseToken, leaseExpiresAt: new Date(Date.now() + 10 * 60_000) });
    if (!attempt) return { success: false, message: "Resolution is unavailable" };
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) return { success: false, message: "Stripe is not configured" };
    try {
      const result = await resolveLegacyPackageCheckoutMultiple({ stripe: new Stripe(secret), attempt, discoveryToken, recoveryLeaseToken: leaseToken, operatorUserId: session.user.id, choice: choice === "all-refund" ? { kind: "all-refund" } : { kind: "choose", sessionId: choice } });
      try { await addAuditLog({ userId: session.user.id, action: auditLogActions.admin.packageCheckoutResolution, details: `attemptId: ${attempt.id}, discoveryToken: ${discoveryToken}, choice: ${choice}, refunds: ${result.refundCount}` }); } catch { /* durable resolution operatorUserId remains authoritative */ }
      return { success: true, message: `Resolution scheduled (${result.refundCount} refunds)` };
    } catch (error) {
      await reschedulePackageCheckoutIntervention({ id: attempt.id, discoveryToken, leaseToken, notBefore: new Date(), lastError: error instanceof Error ? error.message : "Resolution failed" });
      return { success: false, message: error instanceof Error ? error.message : "Resolution failed" };
    }
  });
}

function parseTopUpInterventionInput(input: unknown) {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  if (typeof value.topUpAttemptId !== "string" ||
      typeof value.ownerUserId !== "string" ||
      typeof value.stripeCustomerId !== "string" ||
      typeof value.billingOfferId !== "string" ||
      typeof value.expectedRevision !== "number" ||
      !Number.isSafeInteger(value.expectedRevision) ||
      typeof value.expectedInterventionAt !== "string") return null;
  const expectedInterventionAt = new Date(value.expectedInterventionAt);
  if (!Number.isFinite(expectedInterventionAt.getTime())) return null;
  return { topUpAttemptId: value.topUpAttemptId, ownerUserId: value.ownerUserId, stripeCustomerId: value.stripeCustomerId, billingOfferId: value.billingOfferId, expectedRevision: value.expectedRevision, expectedInterventionAt };
}

export async function resumeTopUpCheckoutRecovery(input: unknown): Promise<ActionResult> {
  return await adminAction(async (session) => {
    const parsed = parseTopUpInterventionInput(input);
    if (!parsed) return { success: false, message: "Invalid resolver input" };
    const result = await startRetryableTransaction(async (tx) => {
      const transition = await resumeTopUpCheckoutIntervention({ ...parsed, prisma: tx });
      if (transition.status === "conflict" || transition.status === "unsafe") return transition;
      await addAuditLog({ userId: session.user.id, action: auditLogActions.admin.topUpCheckoutInterventionResumed, details: `attemptId: ${parsed.topUpAttemptId}, revision: ${parsed.expectedRevision}->${transition.revision}`, prisma: tx });
      return transition;
    });
    return result.status === "resumed"
      ? { success: true, message: "Top-up recovery resumed" }
      : { success: false, message: result.status === "unsafe" ? result.reason : "Resolution changed; reload and retry" };
  });
}

export async function terminalizeTopUpCheckoutRecovery(input: unknown): Promise<ActionResult> {
  return await adminAction(async (session) => {
    const parsed = parseTopUpInterventionInput(input);
    if (!parsed) return { success: false, message: "Invalid resolver input" };
    const value = input as Record<string, unknown>;
    if (typeof value.operatorReason !== "string" || value.operatorReason.trim().length < 10 || typeof value.operatorEvidence !== "string" || value.operatorEvidence.trim().length < 10) {
      return { success: false, message: "A detailed operator reason and evidence are required" };
    }
    const result = await startRetryableTransaction(async (tx) => {
      const transition = await terminalizeTopUpCheckoutIntervention({ ...parsed, operatorUserId: session.user.id, operatorReason: value.operatorReason as string, operatorEvidence: value.operatorEvidence as string, prisma: tx });
      if (transition.status === "conflict") return transition;
      if (transition.status === "unsafe") return transition;
      await addAuditLog({ userId: session.user.id, action: auditLogActions.admin.topUpCheckoutInterventionTerminalized, details: `attemptId: ${parsed.topUpAttemptId}, revision: ${parsed.expectedRevision}->${transition.revision}`, prisma: tx });
      return transition;
    });
    return result.status === "terminalized"
      ? { success: true, message: "Top-up recovery terminalized" }
      : { success: false, message: result.status === "unsafe" ? result.reason : "Resolution changed; reload and retry" };
  });
}


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

    // The intent is committed before any remote work and is deliberately kept
    // when closure fails. A later admin retry resumes the same remote saga.
    const reservation = await startRetryableTransaction(async (tx) =>
      await reserveAdminAccountDeletion({ userId, prisma: tx }),
    );
    if (reservation.status !== "reserved") {
      const message = {
        "already-authorized": "Account deletion is already in progress",
        subscription:
          "Cancel this user's Pro subscription before deleting the account",
        checkout:
          "Resolve this user's pending Pro checkout before deleting the account",
        customer: "Close this user's Stripe customer before deleting the account",
        provisioning: "Wait for this user's Stripe customer provisioning to settle",
      }[reservation.reason];
      return { success: false, message };
    }
    const intent = await findAccountDeletionIntentByUserId({ userId });
    if (!intent) {
      return { success: false, message: "Account deletion intent was not persisted" };
    }
    const closure = await closeStripeCustomerForAdminAccountDeletion({
      userId,
      stripeCustomerId: intent.stripeCustomerId,
      deletionAuthorizedAt: intent.authorizedAt,
    });
    if (closure.status === "owner-mismatch") {
      return { success: false, message: "Stripe customer ownership could not be verified" };
    }
    if (closure.status === "active-subscription") {
      return { success: false, message: "Cancel this user's Pro subscription before deleting the account" };
    }

    const result = await startRetryableTransaction(async (tx) => {
      const currentIntent = await findAccountDeletionIntentByUserId({ userId, prisma: tx });
      if (!currentIntent) return { status: "already-completed" as const };
      // The remote closure ran outside this transaction. Revalidate the exact
      // intent snapshot and Customer identity before cascading rows; otherwise
      // a provisioning/mapping race could make a successful closure apply to
      // a newly assigned Customer.
      if (
        currentIntent.stripeCustomerId !== intent.stripeCustomerId ||
        closure.customerId !== currentIntent.stripeCustomerId
      ) {
        return { status: "blocked" as const, reason: "customer" as const };
      }
      const subscription = await getSubscriptionByUserId({ userId, prisma: tx });
      if (subscription && isActiveProSubscription(subscription)) {
        return { status: "blocked" as const, reason: "subscription" as const };
      }
      const provisioning = await tx.stripeCustomerProvisioning.findFirst({
        where: {
          userId,
          status: { in: ["pending", "mapping", "cleanup_required", "intervention"] },
        },
        select: { id: true },
      });
      if (provisioning) {
        return { status: "blocked" as const, reason: "provisioning" as const };
      }
      const mapping = await findCustomerByUserId({ userId, prisma: tx });
      if (mapping && mapping.stripeId !== currentIntent.stripeCustomerId) {
        return { status: "blocked" as const, reason: "customer" as const };
      }
      if (mapping && closure.status !== "closed" && closure.status !== "already-closed") {
        return { status: "blocked" as const, reason: "customer" as const };
      }
      // 本人が消すときと同じ後始末を、同じトランザクションで。行が消えたあとに
      // 外の持ちものを指す手掛かりは残らないので、消す前に控えを取る——R2 の
      // オブジェクトと、走っている provider の job がそれ。
      const prepared = await prepareAccountDeletionOutboxes({ userId, prisma: tx });
      if (prepared.unboundCheckoutRecoveries > 0) {
        return { status: "blocked" as const, reason: "checkout" as const };
      }
      if (prepared.customerProvisioningRecoveries > 0) {
        return { status: "blocked" as const, reason: "provisioning" as const };
      }
      await enqueueUserStorageCleanups({ userId, prisma: tx });
      await deleteUserById({ userId, prisma: tx });
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.admin.userDeleted,
        details: `userId: ${userId}`,
        prisma: tx,
      });
      return { status: "deleted" as const };
    });
    if (result.status === "blocked") {
      const message = {
        subscription:
          "Cancel this user's Pro subscription before deleting the account",
        checkout:
          "Resolve this user's pending Pro checkout before deleting the account",
        customer: "Close this user's Stripe customer before deleting the account",
        provisioning: "Wait for this user's Stripe customer provisioning to settle",
      }[result.reason];
      return { success: false, message };
    }
    if (result.status === "already-completed") return { success: true };
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
