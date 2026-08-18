"use server";

import { addAuditLog, auditLogActions } from "@beutl/next/audit-log";
import type { ActionResult } from "@beutl/core";
import { adminAction } from "@/lib/auth-guard";
import {
  deleteAiSetting,
  startRetryableTransaction,
  upsertAiSetting,
} from "@beutl/db";
import { loadAiSettings } from "@beutl/api";
import {
  validateAiSettingChanges,
  type AiSettingChange,
} from "@/lib/ai-setting-changes";
import { revalidatePath } from "next/cache";

// Nothing but Server Actions may be exported from this file — not even a type.
// Turbopack walks every export at runtime to register the actions, so a
// re-exported type is evaluated as a value and throws. Callers import
// AiSettingChange from @/lib/ai-setting-changes instead.

// One page holds every model, price, and the allowance. Editing several and
// pressing save once is the normal case, so the whole set is applied in a
// single transaction: a repricing that landed half-applied would bill some
// operations at the new rate and some at the old one.
export async function updateAiSettings({
  changes,
}: {
  changes: AiSettingChange[];
}): Promise<ActionResult> {
  return await adminAction(async (session) => {
    // Commit the audit log and the setting updates in the same transaction.
    // These values can change billing rates, so always record who changed what,
    // one entry per setting so the log stays greppable by key.
    //
    // Validation reads inside that transaction because it is a cross-field
    // rule: the settings the batch leaves alone take part in it, so checking a
    // price against an allowance read beforehand lets one save lower the
    // allowance while another raises a price, each accepting against a snapshot
    // the other invalidates. Read together, the write conflict is one
    // startRetryableTransaction already retries.
    const outcome = await startRetryableTransaction(async (tx) => {
      const current = await loadAiSettings({ prisma: tx });
      const stored = new Map(
        current.all().map((setting) => [setting.key, setting.value]),
      );
      const validated = validateAiSettingChanges(
        changes,
        (key) => stored.get(key) ?? "",
      );
      if (!validated.ok) {
        return { ok: false as const, message: validated.message };
      }
      for (const change of validated.changes) {
        if (change.value === null) {
          await deleteAiSetting({ key: change.key, prisma: tx });
          await addAuditLog({
            userId: session.user.id,
            action: auditLogActions.admin.aiSettingReset,
            details: `key: ${change.key}`,
            prisma: tx,
          });
          continue;
        }
        await upsertAiSetting({
          key: change.key,
          value: change.value,
          updatedBy: session.user.id,
          prisma: tx,
        });
        await addAuditLog({
          userId: session.user.id,
          action: auditLogActions.admin.aiSettingChanged,
          details: `key: ${change.key}, value: ${change.value}`,
          prisma: tx,
        });
      }
      return { ok: true as const };
    });
    if (!outcome.ok) {
      return { success: false, message: outcome.message };
    }
    revalidatePath("/[lang]/admin/ai", "page");

    return { success: true };
  });
}
