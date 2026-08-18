"use server";

import { addAuditLog, auditLogActions } from "@beutl/next/audit-log";
import type { ActionResult } from "@beutl/core";
import { adminAction } from "@/lib/auth-guard";
import {
  deleteAiOperationModel,
  deleteAiSetting,
  listAiOperationModels,
  setAiOperationModelSortOrder,
  startRetryableTransaction,
  upsertAiOperationModel,
  upsertAiSetting,
} from "@beutl/db";
import { loadAiModelCatalog, loadAiSettings } from "@beutl/api";
import {
  validateAiSettingChanges,
  type AiSettingChange,
} from "@/lib/ai-setting-changes";
import {
  aiOperationWouldGoOffline,
  aiOperationsGoingOffline,
  orderWithDefaultFirst,
  sortOrderForSavedModel,
  validateAiOperationModelInput,
} from "@/lib/ai-operation-model-changes";
import { AI_OPERATIONS, aiMinimumChargeOf } from "@beutl/core";
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
      // An allowance below every model's price takes that operation offline for
      // everyone on the plan. The prices are rows rather than settings, so the
      // check reads them here — in the same transaction, because a concurrent
      // repricing would otherwise be evaluated against a snapshot this save
      // invalidates.
      const catalog = await loadAiModelCatalog({ prisma: tx });
      const offline = aiOperationsGoingOffline({
        minimumChargeOf: (operation, priceUnits) =>
          aiMinimumChargeOf(operation, priceUnits) ?? priceUnits,
        // The catalog already resolves an operation with no rows to its
        // built-in model, and only lists the selectable ones.
        modelsByOperation: Object.fromEntries(
          AI_OPERATIONS.map((operation) => [
            operation,
            catalog
              .list(operation)
              .map((entry) => ({ priceUnits: entry.priceUnits, enabled: true })),
          ]),
        ),
        allowance: validated.allowance,
      });
      if (offline.length > 0) {
        return {
          ok: false as const,
          message: `A ${validated.allowance} unit allowance cannot start any model registered for ${offline.join(", ")}`,
        };
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

// Registering or editing one model an operation may run on.
//
// Saved on its own rather than through updateAiSettings: that batch is capped
// at 64 changes and validates every key against the allowance, neither of which
// fits a table whose length is up to the administrator.
export async function saveAiOperationModel(input: unknown): Promise<ActionResult> {
  const validated = validateAiOperationModelInput(input);
  if (!validated.ok) {
    return { success: false, message: validated.message };
  }
  const model = validated.value;

  return await adminAction(async (session) => {
    const outcome = await startRetryableTransaction(async (tx) => {
      const settings = await loadAiSettings({ prisma: tx });
      const allowance = settings.getMonthlyUsageLimit();
      // Read the operation's other rows inside the transaction: whether this
      // save takes the operation offline depends on them, and reading them
      // beforehand would let two concurrent saves each pass against a snapshot
      // the other invalidates.
      const rows = (await listAiOperationModels({ prisma: tx })).filter(
        (row) => row.operation === model.operation,
      );
      const next = [
        ...rows.filter((row) => row.modelId !== model.modelId),
        model,
      ];
      if (
        aiOperationWouldGoOffline({
          minimumChargeOf: (priceUnits) =>
            aiMinimumChargeOf(model.operation, priceUnits) ?? priceUnits,
          models: next,
          allowance,
        })
      ) {
        return {
          ok: false as const,
          message: `No enabled model for ${model.operation} is startable within the ${allowance} unit monthly allowance`,
        };
      }

      const sortOrder = sortOrderForSavedModel({
        rows,
        modelId: model.modelId,
      });
      await upsertAiOperationModel({
        ...model,
        sortOrder,
        updatedBy: session.user.id,
        prisma: tx,
      });
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.admin.aiOperationModelSaved,
        details: `operation: ${model.operation}, model: ${model.modelId}, price: ${model.priceUnits}, enabled: ${model.enabled}`,
        prisma: tx,
      });
      return { ok: true as const };
    });
    if (!outcome.ok) {
      return { success: false, message: outcome.message };
    }
    revalidatePath("/[lang]/admin/ai", "page");
    return { success: true };
  });
}

// Removing the last row for an operation is not an error: the operation then
// runs on the single model and price the settings page holds, which is where it
// started.
export async function removeAiOperationModel(input: unknown): Promise<ActionResult> {
  if (typeof input !== "object" || input === null) {
    return { success: false, message: "Invalid model" };
  }
  const { operation, modelId } = input as Record<string, unknown>;
  if (typeof operation !== "string" || typeof modelId !== "string") {
    return { success: false, message: "Invalid model" };
  }

  return await adminAction(async (session) => {
    await startRetryableTransaction(async (tx) => {
      await deleteAiOperationModel({ operation, modelId, prisma: tx });
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.admin.aiOperationModelRemoved,
        details: `operation: ${operation}, model: ${modelId}`,
        prisma: tx,
      });
    });
    revalidatePath("/[lang]/admin/ai", "page");
    return { success: true };
  });
}

// Making a model the default, which is the lowest sort order within its
// operation. Renumbering every row keeps that unambiguous: two rows sharing the
// lowest order would leave the default to the id tie-break.
export async function setDefaultAiOperationModel(
  input: unknown,
): Promise<ActionResult> {
  if (typeof input !== "object" || input === null) {
    return { success: false, message: "Invalid model" };
  }
  const { operation, modelId } = input as Record<string, unknown>;
  if (typeof operation !== "string" || typeof modelId !== "string") {
    return { success: false, message: "Invalid model" };
  }

  return await adminAction(async (session) => {
    const outcome = await startRetryableTransaction(async (tx) => {
      const rows = (await listAiOperationModels({ prisma: tx })).filter(
        (row) => row.operation === operation,
      );
      const chosen = rows.find((row) => row.modelId === modelId);
      if (!chosen) {
        return { ok: false as const, message: "That model is not registered" };
      }
      if (!chosen.enabled) {
        // The default is the first model a request can actually run on, so a
        // model nobody may pick cannot be it.
        return {
          ok: false as const,
          message: "A model that is not selectable cannot be the default",
        };
      }

      const ordered = orderWithDefaultFirst({ rows, modelId });
      for (const [index, orderedModelId] of ordered.entries()) {
        const row = rows.find((entry) => entry.modelId === orderedModelId);
        if (row?.sortOrder === index) continue;
        await setAiOperationModelSortOrder({
          operation,
          modelId: orderedModelId,
          sortOrder: index,
          updatedBy: session.user.id,
          prisma: tx,
        });
      }
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.admin.aiOperationModelDefaulted,
        details: `operation: ${operation}, model: ${modelId}`,
        prisma: tx,
      });
      return { ok: true as const };
    });
    if (!outcome.ok) {
      return { success: false, message: outcome.message };
    }
    revalidatePath("/[lang]/admin/ai", "page");
    return { success: true };
  });
}
