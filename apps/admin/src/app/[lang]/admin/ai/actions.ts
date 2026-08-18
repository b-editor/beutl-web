"use server";

import { addAuditLog, auditLogActions } from "@beutl/next/audit-log";
import type { ActionResult } from "@beutl/core";
import { adminAction } from "@/lib/auth-guard";
import {
  deleteAiOperationModel,
  deleteAiSetting,
  listAiOperationModels,
  startRetryableTransaction,
  upsertAiOperationModel,
  upsertAiSetting,
} from "@beutl/db";
import {
  aiCostEstimateKey,
  loadAiCostEstimates,
  loadAiModelCatalog,
  loadAiSettings,
} from "@beutl/api";
import { getDb } from "@beutl/db";
import { deriveTopUpUnitValue, isAiModelId } from "@beutl/core";
import { resolveOfferPricing } from "@/lib/stripe-pricing";
import { validateAiConfigurationChanges } from "@/lib/ai-configuration-changes";
import {
  AI_DEFAULT_OPERATION_MODELS,
  aiMinimumChargeOf,
} from "@beutl/core";
import { revalidatePath } from "next/cache";

// Nothing but Server Actions may be exported from this file — not even a type.
// Turbopack walks every export at runtime to register the actions, so a
// re-exported type is evaluated as a value and throws. Callers import the
// change types from @/lib/ai-configuration-changes instead.

// The whole AI configuration is saved at once: the allowance and every
// operation's list of models, in one transaction.
//
// Committing them separately made every ordering between them a state someone
// could be looking at — an allowance saved before the model it was raised for
// is an operation nobody can start — and left the page with two save
// mechanisms for one screen.
export async function saveAiConfiguration(input: unknown): Promise<ActionResult> {
  return await adminAction(async (session) => {
    // Validation reads inside the transaction because it is a cross-field rule
    // over state this save does not carry: the settings and operations it
    // leaves alone take part in it, so checking against a snapshot read
    // beforehand lets two saves each pass against a state the other
    // invalidates. Read together, the write conflict is one
    // startRetryableTransaction already retries.
    const outcome = await startRetryableTransaction(async (tx) => {
      const [current, catalog, storedRows] = await Promise.all([
        loadAiSettings({ prisma: tx }),
        loadAiModelCatalog({ prisma: tx }),
        listAiOperationModels({ prisma: tx }),
      ]);
      const stored = new Map(
        current.all().map((setting) => [setting.key, setting.value]),
      );

      const validated = validateAiConfigurationChanges(input, {
        currentSettingValueOf: (key) => stored.get(key) ?? "",
        storedModelsOf: (operation) =>
          catalog
            .list(operation)
            .map((entry) => ({ priceUnits: entry.priceUnits, enabled: true })),
        builtInModelsOf: (operation) => {
          const defaults = (
            AI_DEFAULT_OPERATION_MODELS as Record<string, { price: number }>
          )[operation];
          return defaults
            ? [{ priceUnits: defaults.price, enabled: true }]
            : [];
        },
        minimumChargeOf: (operation, priceUnits) =>
          aiMinimumChargeOf(operation, priceUnits) ?? priceUnits,
      });
      if (!validated.ok) {
        return { ok: false as const, message: validated.message };
      }

      // These values decide what users are charged, so record who changed what,
      // one entry per setting and per model so the log stays greppable.
      for (const change of validated.settings) {
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

      for (const draft of validated.models) {
        const existing = storedRows.filter(
          (row) => row.operation === draft.operation,
        );
        const submitted = new Set(draft.models.map((model) => model.modelId));
        for (const row of existing) {
          if (submitted.has(row.modelId)) continue;
          await deleteAiOperationModel({
            operation: draft.operation,
            modelId: row.modelId,
            prisma: tx,
          });
          await addAuditLog({
            userId: session.user.id,
            action: auditLogActions.admin.aiOperationModelRemoved,
            details: `operation: ${draft.operation}, model: ${row.modelId}`,
            prisma: tx,
          });
        }

        for (const [index, model] of draft.models.entries()) {
          const before = existing.find((row) => row.modelId === model.modelId);
          const unchanged =
            before !== undefined &&
            before.priceUnits === model.priceUnits &&
            before.displayName === model.displayName &&
            before.enabled === model.enabled &&
            before.sortOrder === index;
          if (unchanged) continue;
          // The submitted order is the display order, and its first entry is
          // what a request that names no model runs on.
          await upsertAiOperationModel({
            ...model,
            sortOrder: index,
            updatedBy: session.user.id,
            prisma: tx,
          });
          await addAuditLog({
            userId: session.user.id,
            action: auditLogActions.admin.aiOperationModelSaved,
            details: `operation: ${draft.operation}, model: ${model.modelId}, price: ${model.priceUnits}, order: ${index}, enabled: ${model.enabled}`,
            prisma: tx,
          });
        }
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

// What one model would cost to run, for a row being added or edited.
//
// The saved rows get their figures rendered on the server, but a model that is
// only typed into the form has none: the provider's rate card is keyed by model
// id, so there is nothing to look up until the id exists. Without this the one
// number worth knowing while choosing a price — what share of it goes to the
// provider — appears only after the price is already saved.
export async function lookupAiModelEconomics(input: unknown) {
  if (typeof input !== "object" || input === null) {
    return { success: false as const, message: "Invalid model" };
  }
  const { operation, modelId } = input as Record<string, unknown>;
  if (typeof operation !== "string" || !isAiModelId(modelId)) {
    return { success: false as const, message: "Invalid model" };
  }

  return await adminAction(async () => {
    // Both go over the network. The rate card is cached per URL path and the
    // Stripe prices per request, so retyping an id costs one fetch at most.
    const prisma = await getDb();
    const [costs, pro, topUp] = await Promise.all([
      loadAiCostEstimates({ modelsOf: () => [modelId] }),
      resolveOfferPricing({ kind: "pro", prisma }),
      resolveOfferPricing({ kind: "top_up", prisma }),
    ]);

    return {
      success: true as const,
      estimate:
        costs.entries.find(
          (entry) =>
            aiCostEstimateKey(entry.operation, entry.model) ===
            aiCostEstimateKey(operation, modelId),
        )?.estimate ?? null,
      proOffer: pro.effective
        ? {
            unitAmount: pro.effective.unitAmount,
            currency: pro.effective.currency,
            creditAmount: pro.effective.creditAmount,
          }
        : null,
      topUpUnitValue: deriveTopUpUnitValue(topUp.effective),
    };
  });
}
