// Which models an operation can run on, and what each one costs.
//
// Price and model used to be resolved separately — `settings.getPrice(op)` at
// the reservation and `settings.getModel(op)` at the provider call, sharing
// nothing but the operation string. With several models per operation that
// split is unsafe: the two lookups could disagree and the user would be charged
// one model's price for another model's work. Everything here resolves both
// together, from one row.
//
// `costTier` is the only thing a client learns about relative price. It is
// derived from the ordering inside an operation, so it is always consistent
// with the real prices while revealing no amount — see the comment on
// `assignCostTiers`.
import { listAiOperationModels } from "@beutl/db";
import type { PrismaTransaction } from "@beutl/db";
import { AI_OPERATIONS, AI_DEFAULT_OPERATION_MODELS } from "@beutl/core";

export type AiModelCostTier = "low" | "medium" | "high";

export type AiOperationModelEntry = {
  operation: string;
  modelId: string;
  priceUnits: number;
  displayName: string;
  sortOrder: number;
  // Absent when the operation offers a single model: there is nothing to be
  // relatively higher or lower than.
  costTier: AiModelCostTier | null;
};

export type AiModelCatalog = {
  /** Enabled models for the operation, in display order. Never empty. */
  list(operation: string): AiOperationModelEntry[];
  /** The model a request that names none will run on. */
  getDefault(operation: string): AiOperationModelEntry;
  /** Null when the id is unknown or the row is disabled. */
  resolve(operation: string, modelId?: string | null): AiOperationModelEntry | null;
  operations(): string[];
};

// Ordering only. Two models split into low/high, three or more into thirds by
// price rank. A count of remaining runs would be the obvious alternative and is
// deliberately not offered: purchased credits are shown to the user as a raw
// number, so "you can run this 12 more times" would let anyone divide out the
// unit price the server exists to keep.
function assignCostTiers(
  entries: Omit<AiOperationModelEntry, "costTier">[],
): AiOperationModelEntry[] {
  if (entries.length <= 1) {
    return entries.map((entry) => ({ ...entry, costTier: null }));
  }

  const byPrice = [...entries].sort(
    (left, right) =>
      left.priceUnits - right.priceUnits ||
      left.modelId.localeCompare(right.modelId),
  );
  const tierOf = new Map<string, AiModelCostTier>();
  if (byPrice.length === 2) {
    tierOf.set(byPrice[0].modelId, "low");
    tierOf.set(byPrice[1].modelId, "high");
  } else {
    const third = byPrice.length / 3;
    byPrice.forEach((entry, index) => {
      tierOf.set(
        entry.modelId,
        index < third ? "low" : index < third * 2 ? "medium" : "high",
      );
    });
  }

  return entries.map((entry) => ({
    ...entry,
    costTier: tierOf.get(entry.modelId) ?? null,
  }));
}

function builtInDefaultsOf(
  operation: string,
): { model: string; price: number } | undefined {
  return (
    AI_DEFAULT_OPERATION_MODELS as Record<
      string,
      { model: string; price: number }
    >
  )[operation];
}

// What an operation runs on when nothing has been registered for it. The
// migration seeds a row for every operation that exists today, so this is
// reached only by one added in code before an administrator has registered
// anything — which is why it is the built-in default rather than a stored
// value.
function builtInEntry(operation: string): Omit<AiOperationModelEntry, "costTier"> {
  const defaults = builtInDefaultsOf(operation);
  if (!defaults) {
    throw new Error(`Unknown AI operation: ${operation}`);
  }
  return {
    operation,
    modelId: defaults.model,
    priceUnits: defaults.price,
    displayName: defaults.model,
    sortOrder: 0,
  };
}

export async function loadAiModelCatalog({
  prisma,
}: {
  prisma?: PrismaTransaction;
} = {}): Promise<AiModelCatalog> {
  const rows = await listAiOperationModels({ prisma });
  const byOperation = new Map<string, Omit<AiOperationModelEntry, "costTier">[]>();
  // 行が 1 つでもある操作は「管理画面で設定済み」。全部無効にしたのは、その操作を
  // 止めるという明示的な指示なので、組み込みの既定で埋めてはならない。
  const configured = new Set<string>();
  for (const row of rows) {
    if (builtInDefaultsOf(row.operation) === undefined) continue;
    configured.add(row.operation);
    if (!row.enabled) continue;
    const entries = byOperation.get(row.operation) ?? [];
    entries.push({
      operation: row.operation,
      modelId: row.modelId,
      priceUnits: row.priceUnits,
      displayName: row.displayName?.trim() || row.modelId,
      sortOrder: row.sortOrder,
    });
    byOperation.set(row.operation, entries);
  }

  const resolved = new Map<string, AiOperationModelEntry[]>();
  for (const operation of AI_OPERATIONS) {
    // まだ 1 行も無い操作だけが組み込みの既定で動く。これは行を作る前の初期状態
    // であって、止められた状態ではない。
    const entries = byOperation.get(operation) ??
      (configured.has(operation) ? [] : [builtInEntry(operation)]);
    resolved.set(operation, assignCostTiers(entries));
  }

  const list = (operation: string) => resolved.get(operation) ?? [];

  return {
    list,
    getDefault(operation) {
      const entries = list(operation);
      if (entries.length === 0) {
        throw new Error(`Unknown AI operation: ${operation}`);
      }
      // Lowest sortOrder wins; the read is already ordered by (sortOrder,
      // modelId), so the first entry is it.
      return entries[0];
    },
    resolve(operation, modelId) {
      const entries = list(operation);
      if (entries.length === 0) return null;
      if (modelId === undefined || modelId === null || modelId === "") {
        return entries[0];
      }
      return entries.find((entry) => entry.modelId === modelId) ?? null;
    },
    operations: () => [...resolved.keys()],
  };
}
