"use server";

import { addAuditLog, auditLogActions } from "@beutl/next/audit-log";
import type { ActionResult } from "@beutl/core";
import { adminAction } from "@/lib/auth-guard";
import {
  deleteAiSetting,
  startRetryableTransaction,
  upsertAiSetting,
} from "@beutl/db";
import { isAiSettingKey, validateAiSettingValue } from "@beutl/core";
import { revalidatePath } from "next/cache";

export async function updateAiSetting({
  key,
  value,
}: {
  key: string;
  value: string;
}): Promise<ActionResult> {
  return await adminAction(async (session) => {
    // Server Action の引数は型注釈が実行時に消えるため、値域をここで検証する。
    if (!isAiSettingKey(key)) {
      return { success: false, message: "Invalid setting key" };
    }
    if (typeof value !== "string") {
      return { success: false, message: "Invalid setting value" };
    }
    const validated = validateAiSettingValue(key, value);
    if (!validated.ok) {
      return { success: false, message: `Invalid value: ${validated.error}` };
    }

    // 監査ログと設定の書き込みは同一トランザクションで確定させる。
    // 課金単価を変えうる操作なので「誰が何をいつ変えたか」を必ず残す。
    await startRetryableTransaction(async (tx) => {
      await upsertAiSetting({
        key,
        value: validated.value,
        updatedBy: session.user.id,
        prisma: tx,
      });
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.admin.aiSettingChanged,
        details: `key: ${key}, value: ${validated.value}`,
        prisma: tx,
      });
    });
    revalidatePath("/[lang]/admin/ai", "page");

    return { success: true };
  });
}

export async function resetAiSetting({
  key,
}: {
  key: string;
}): Promise<ActionResult> {
  return await adminAction(async (session) => {
    if (!isAiSettingKey(key)) {
      return { success: false, message: "Invalid setting key" };
    }

    await startRetryableTransaction(async (tx) => {
      await deleteAiSetting({ key, prisma: tx });
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.admin.aiSettingReset,
        details: `key: ${key}`,
        prisma: tx,
      });
    });
    revalidatePath("/[lang]/admin/ai", "page");

    return { success: true };
  });
}
