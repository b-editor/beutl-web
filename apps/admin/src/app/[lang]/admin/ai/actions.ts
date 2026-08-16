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
    // Server Action arguments lose their type annotations at runtime, so
    // validate their ranges here.
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

    // Commit the audit log and setting update in the same transaction. This
    // operation can change billing rates, so always record who changed what.
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
