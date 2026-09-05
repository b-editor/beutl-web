import type { AiOperationModelSnapshot } from "./ai-configuration-changes";

export type AiModelDraftRow = {
  modelId: string;
  priceUnits: number;
  displayName: string | null;
  enabled: boolean;
};

export type ModelDraftState = {
  rows: AiModelDraftRow[];
  expected: AiOperationModelSnapshot[];
};

export type ModelDraftAction =
  | {
      type: "set";
      operation: string;
      rows: AiModelDraftRow[];
      saved: AiModelDraftRow[];
      snapshot: AiOperationModelSnapshot[];
    }
  | { type: "clear" };

function sameModels(left: AiModelDraftRow[], right: AiModelDraftRow[]): boolean {
  return (
    left.length === right.length &&
    left.every((model, index) => {
      const other = right[index]!;
      return (
        model.modelId === other.modelId &&
        model.priceUnits === other.priceUnits &&
        model.displayName === other.displayName &&
        model.enabled === other.enabled
      );
    })
  );
}

export function reduceModelDrafts(
  current: ReadonlyMap<string, ModelDraftState>,
  action: ModelDraftAction,
): Map<string, ModelDraftState> {
  if (action.type === "clear") return new Map();

  const next = new Map(current);
  if (sameModels(action.saved, action.rows)) {
    next.delete(action.operation);
    return next;
  }

  const previous = current.get(action.operation);
  next.set(action.operation, {
    rows: action.rows,
    expected: previous?.expected ?? action.snapshot,
  });
  return next;
}

export function serializeModelDrafts(
  drafts: ReadonlyMap<string, ModelDraftState>,
): { operation: string; models: AiModelDraftRow[]; expected: AiOperationModelSnapshot[] }[] {
  return [...drafts].map(([operation, draft]) => ({
    operation,
    models: draft.rows,
    expected: draft.expected,
  }));
}
