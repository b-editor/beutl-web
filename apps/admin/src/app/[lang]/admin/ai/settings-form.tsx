"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { useTranslation } from "@beutl/ui/i18n-client";
import { useToast } from "@beutl/ui/use-toast";
import { Button } from "@beutl/ui/ui/button";
import type { AiSettingChange } from "@/lib/ai-setting-changes";
import { saveAiConfiguration } from "./actions";

export type AiSettingRow = {
  key: string;
  kind: "limit";
  value: string;
  source: "database" | "default";
  fallback: string;
};

// One model an operation offers. The array's order is the display order, and
// its first selectable entry is what a request that names no model runs on.
export type AiModelRow = {
  modelId: string;
  priceUnits: number;
  displayName: string | null;
  enabled: boolean;
};

// A setting is either being edited to a new value, or marked to fall back to
// the built-in default. "Reset" is not the same as typing the default value in:
// it removes the stored row, so the setting follows the default if that default
// ever changes.
//
// Only the allowance is left here. Models and their prices are rows in a table,
// saved one at a time — see model-list.
type Draft = {
  value: string;
  reset: boolean;
};

type FormContextValue = {
  settings: Map<string, AiSettingRow>;
  drafts: Map<string, Draft>;
  // Server state and the edited state, per operation. A whole list rather than
  // a set of edits: adding, repricing, removing and reordering are then the
  // same thing to compare and to submit.
  models: Map<string, AiModelRow[]>;
  modelDrafts: Map<string, AiModelRow[]>;
  isPending: boolean;
  setValue(key: string, value: string): void;
  markReset(key: string): void;
  setModels(operation: string, models: AiModelRow[]): void;
};

const FormContext = createContext<FormContextValue | null>(null);

function draftOf(
  drafts: Map<string, Draft>,
  setting: AiSettingRow,
): Draft {
  return drafts.get(setting.key) ?? { value: setting.value, reset: false };
}

function sameModels(left: AiModelRow[], right: AiModelRow[]): boolean {
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

function isChanged(setting: AiSettingRow, draft: Draft): boolean {
  if (draft.reset) {
    // Resetting a setting that was never stored would delete nothing.
    return setting.source === "database";
  }
  return draft.value.trim() !== setting.value;
}

export function useAiSettingField(key: string) {
  const context = useContext(FormContext);
  if (!context) {
    throw new Error("useAiSettingField must be used inside AiConfigurationForm");
  }
  const setting = context.settings.get(key);
  if (!setting) {
    throw new Error(`Unknown AI setting key: ${key}`);
  }
  const draft = draftOf(context.drafts, setting);
  return {
    setting,
    value: draft.value,
    reset: draft.reset,
    changed: isChanged(setting, draft),
    isPending: context.isPending,
    setValue: (value: string) => context.setValue(key, value),
    markReset: () => context.markReset(key),
  };
}

// The models an operation offers, with unsaved edits applied.
export function useAiModels(operation: string): {
  models: AiModelRow[];
  changed: boolean;
  isPending: boolean;
  setModels(models: AiModelRow[]): void;
} {
  const context = useContext(FormContext);
  if (!context) {
    throw new Error("useAiModels must be used inside AiConfigurationForm");
  }
  const saved = context.models.get(operation) ?? [];
  const draft = context.modelDrafts.get(operation);
  return {
    models: draft ?? saved,
    changed: draft !== undefined,
    isPending: context.isPending,
    setModels: (models) => context.setModels(operation, models),
  };
}

// What a model would cost once the page is saved, which is what the figures
// under its row are derived from. Falls back to the saved price for a row the
// draft does not carry.
export function useAiModelPrice(
  operation: string,
  modelId: string,
): { priceUnits: number | null; changed: boolean } {
  const context = useContext(FormContext);
  if (!context) {
    throw new Error("useAiModelPrice must be used inside AiConfigurationForm");
  }
  const saved = (context.models.get(operation) ?? []).find(
    (model) => model.modelId === modelId,
  );
  const drafted = context.modelDrafts
    .get(operation)
    ?.find((model) => model.modelId === modelId);
  const effective = drafted ?? saved;
  return {
    priceUnits: effective?.priceUnits ?? null,
    changed:
      drafted !== undefined && drafted.priceUnits !== saved?.priceUnits,
  };
}

// Every setting's current value with unsaved edits applied. Used by the
// summaries that read across the whole page instead of one field, so they
// preview an edit rather than lagging behind it.
export function useAiSettingValues(): Map<string, string> {
  const context = useContext(FormContext);
  if (!context) {
    throw new Error("useAiSettingValues must be used inside AiConfigurationForm");
  }
  const { settings, drafts } = context;
  return useMemo(() => {
    const values = new Map<string, string>();
    for (const [key, setting] of settings) {
      values.set(key, draftOf(drafts, setting).value);
    }
    return values;
  }, [settings, drafts]);
}

export function AiConfigurationForm({
  lang,
  settings,
  models,
  children,
}: {
  lang: string;
  settings: AiSettingRow[];
  models: { operation: string; models: AiModelRow[] }[];
  children: ReactNode;
}) {
  const { t } = useTranslation(lang);
  const { toast } = useToast();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [drafts, setDrafts] = useState<Map<string, Draft>>(new Map());
  const [modelDrafts, setModelDrafts] = useState<Map<string, AiModelRow[]>>(
    new Map(),
  );

  const settingsByKey = useMemo(
    () => new Map(settings.map((setting) => [setting.key, setting])),
    [settings],
  );
  const modelsByOperation = useMemo(
    () => new Map(models.map((entry) => [entry.operation, entry.models])),
    [models],
  );

  // A refresh arriving while nothing is being edited should adopt the server's
  // values. One that arrives mid-edit must not discard what was typed, so the
  // drafts are only cleared when they are empty or a save just committed them.
  const committedRef = useRef(0);
  useEffect(() => {
    if (committedRef.current === 0) return;
    committedRef.current = 0;
    setDrafts(new Map());
    setModelDrafts(new Map());
  }, [settings, models]);

  const setValue = useCallback((key: string, value: string) => {
    setDrafts((previous) => {
      const next = new Map(previous);
      next.set(key, { value, reset: false });
      return next;
    });
  }, []);

  const markReset = useCallback(
    (key: string) => {
      const setting = settingsByKey.get(key);
      if (!setting) return;
      setDrafts((previous) => {
        const next = new Map(previous);
        // Show the default straight away so the field reflects what saving
        // would produce.
        next.set(key, { value: setting.fallback, reset: true });
        return next;
      });
    },
    [settingsByKey],
  );

  const setModels = useCallback(
    (operation: string, next: AiModelRow[]) => {
      setModelDrafts((previous) => {
        const updated = new Map(previous);
        const saved = modelsByOperation.get(operation) ?? [];
        // Editing back to what is stored is not a change, so the save bar and
        // the discard button both stop offering to act on it.
        if (sameModels(saved, next)) {
          updated.delete(operation);
        } else {
          updated.set(operation, next);
        }
        return updated;
      });
    },
    [modelsByOperation],
  );

  const changes = useMemo(() => {
    const pending: { setting: AiSettingRow; draft: Draft }[] = [];
    for (const setting of settings) {
      const draft = drafts.get(setting.key);
      if (!draft) continue;
      if (isChanged(setting, draft)) {
        pending.push({ setting, draft });
      }
    }
    return pending;
  }, [settings, drafts]);

  const pendingCount = changes.length + modelDrafts.size;

  const discard = useCallback(() => {
    setDrafts(new Map());
    setModelDrafts(new Map());
  }, []);

  const save = useCallback(() => {
    if (pendingCount === 0) return;
    const settingChanges: AiSettingChange[] = changes.map(
      ({ setting, draft }) => ({
        key: setting.key,
        value: draft.reset ? null : draft.value.trim(),
      }),
    );
    const modelChanges = [...modelDrafts].map(([operation, rows]) => ({
      operation,
      models: rows,
    }));

    startTransition(async () => {
      try {
        const result = await saveAiConfiguration({
          settings: settingChanges,
          models: modelChanges,
        });
        if (result.success) {
          committedRef.current = pendingCount;
          toast({
            title: t("admin:ai.form.saveSuccess", { total: pendingCount }),
          });
          router.refresh();
        } else {
          toast({
            title: t("admin:ai.form.saveFailed"),
            description: result.message,
            variant: "destructive",
          });
          // The batch is applied all or nothing, so the edits are still valid
          // to retry; leave them in place and re-read the server state.
          router.refresh();
        }
      } catch (e) {
        toast({
          title: t("admin:ai.form.saveFailed"),
          description: e instanceof Error ? e.message : String(e),
          variant: "destructive",
        });
        router.refresh();
      }
    });
  }, [changes, modelDrafts, pendingCount, toast, t, router]);

  const contextValue = useMemo<FormContextValue>(
    () => ({
      settings: settingsByKey,
      drafts,
      models: modelsByOperation,
      modelDrafts,
      isPending,
      setValue,
      markReset,
      setModels,
    }),
    [
      settingsByKey,
      drafts,
      modelsByOperation,
      modelDrafts,
      isPending,
      setValue,
      markReset,
      setModels,
    ],
  );

  return (
    <FormContext.Provider value={contextValue}>
      {children}
      {pendingCount > 0 && (
        <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <span className="text-sm">
            {t("admin:ai.form.pendingCount", { total: pendingCount })}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={isPending}
              onClick={discard}
            >
              {t("admin:ai.form.discard")}
            </Button>
            <Button size="sm" disabled={isPending} onClick={save}>
              {t("admin:ai.form.save")}
            </Button>
          </div>
        </div>
      )}
    </FormContext.Provider>
  );
}
