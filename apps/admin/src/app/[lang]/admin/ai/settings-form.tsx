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
import { updateAiSettings } from "./actions";

export type AiSettingRow = {
  key: string;
  kind: "model" | "price" | "limit";
  value: string;
  source: "database" | "default";
  fallback: string;
};

// A setting is either being edited to a new value, or marked to fall back to
// the built-in default. "Reset" is not the same as typing the default value in:
// it removes the stored row, so the setting follows the default if that default
// ever changes.
type Draft = {
  value: string;
  reset: boolean;
};

type FormContextValue = {
  settings: Map<string, AiSettingRow>;
  drafts: Map<string, Draft>;
  isPending: boolean;
  setValue(key: string, value: string): void;
  markReset(key: string): void;
};

const FormContext = createContext<FormContextValue | null>(null);

function draftOf(
  drafts: Map<string, Draft>,
  setting: AiSettingRow,
): Draft {
  return drafts.get(setting.key) ?? { value: setting.value, reset: false };
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
    throw new Error("useAiSettingField must be used inside AiSettingsForm");
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

// Every setting's current value with unsaved edits applied. Used by the
// summaries that read across the whole page instead of one field, so they
// preview an edit rather than lagging behind it.
export function useAiSettingValues(): Map<string, string> {
  const context = useContext(FormContext);
  if (!context) {
    throw new Error("useAiSettingValues must be used inside AiSettingsForm");
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

export function AiSettingsForm({
  lang,
  settings,
  children,
}: {
  lang: string;
  settings: AiSettingRow[];
  children: ReactNode;
}) {
  const { t } = useTranslation(lang);
  const { toast } = useToast();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [drafts, setDrafts] = useState<Map<string, Draft>>(new Map());

  const settingsByKey = useMemo(
    () => new Map(settings.map((setting) => [setting.key, setting])),
    [settings],
  );

  // A refresh arriving while nothing is being edited should adopt the server's
  // values. One that arrives mid-edit must not discard what was typed, so the
  // drafts are only cleared when they are empty or a save just committed them.
  const committedRef = useRef(0);
  useEffect(() => {
    if (committedRef.current === 0) return;
    committedRef.current = 0;
    setDrafts(new Map());
  }, [settings]);

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

  const discard = useCallback(() => setDrafts(new Map()), []);

  const save = useCallback(() => {
    if (changes.length === 0) return;
    const payload: AiSettingChange[] = changes.map(({ setting, draft }) => ({
      key: setting.key,
      value: draft.reset ? null : draft.value.trim(),
    }));

    startTransition(async () => {
      try {
        const result = await updateAiSettings({ changes: payload });
        if (result.success) {
          committedRef.current = payload.length;
          toast({
            title: t("admin:ai.form.saveSuccess", { total: payload.length }),
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
  }, [changes, toast, t, router]);

  const contextValue = useMemo<FormContextValue>(
    () => ({
      settings: settingsByKey,
      drafts,
      isPending,
      setValue,
      markReset,
    }),
    [settingsByKey, drafts, isPending, setValue, markReset],
  );

  return (
    <FormContext.Provider value={contextValue}>
      {children}
      {changes.length > 0 && (
        <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <span className="text-sm">
            {t("admin:ai.form.pendingCount", { total: changes.length })}
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
