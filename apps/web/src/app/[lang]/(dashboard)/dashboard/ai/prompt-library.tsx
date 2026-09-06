"use client";

import { randomUuid } from "@beutl/core";
import { useTranslation } from "@beutl/ui/i18n-client";
import { Button } from "@beutl/ui/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@beutl/ui/ui/collapsible";
import { Input } from "@beutl/ui/ui/input";
import { BookMarked, ChevronRight, Pin, PinOff, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { accountScopedAiStorageKey } from "@/lib/ai-browser-storage";

export type PromptTemplate = {
  id: string;
  name: string;
  prompt: string;
  style?: string;
  composition?: string;
  motion?: string;
  exclusions?: string;
  pinned: boolean;
};

export type PromptDraft = Omit<PromptTemplate, "id" | "name" | "pinned">;

const PROMPT_LIBRARY_NAMESPACE = "beutl:ai:prompt-library";

// Storage written by an earlier build, or by hand, is not this shape by
// assertion. Applying a template whose prompt is missing flips the controlled
// textarea to uncontrolled and the character counter throws on the next render.
function readOptionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readTemplate(value: unknown): PromptTemplate | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  if (typeof record.name !== "string") return null;
  if (typeof record.prompt !== "string") return null;
  return {
    id: record.id,
    name: record.name,
    prompt: record.prompt,
    ...(readOptionalText(record.style) === undefined
      ? {}
      : { style: record.style as string }),
    ...(readOptionalText(record.composition) === undefined
      ? {}
      : { composition: record.composition as string }),
    ...(readOptionalText(record.motion) === undefined
      ? {}
      : { motion: record.motion as string }),
    ...(readOptionalText(record.exclusions) === undefined
      ? {}
      : { exclusions: record.exclusions as string }),
    pinned: record.pinned === true,
  };
}

function promptLibraryKey(userId: string): string {
  return accountScopedAiStorageKey(PROMPT_LIBRARY_NAMESPACE, userId);
}

function loadPromptLibrary(userId: string): PromptTemplate[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(promptLibraryKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      const template = readTemplate(entry);
      return template ? [template] : [];
    });
  } catch {
    return [];
  }
}

function savePromptLibrary(userId: string, templates: PromptTemplate[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      promptLibraryKey(userId),
      JSON.stringify(templates),
    );
  } catch {
    // ストレージが利用できない環境では保存を諦める。
  }
}

export function PromptLibrary({
  lang,
  userId,
  onApply,
  currentDraft,
}: {
  lang: string;
  userId: string;
  onApply: (template: PromptTemplate) => void;
  // Read at save time rather than passed as a value, so the template captures
  // what is in the form at that moment.
  currentDraft: () => PromptDraft;
}) {
  const { t } = useTranslation(lang);
  const [library, setLibrary] = useState<{
    owner: string | null;
    templates: PromptTemplate[];
  }>({ owner: null, templates: [] });
  const [name, setName] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLibrary({ owner: userId, templates: loadPromptLibrary(userId) });
  }, [userId]);

  // A client-side account transition may reuse this component before its
  // effect loads the new account. Never render the previous owner's drafts in
  // that intervening render.
  const templates = library.owner === userId ? library.templates : [];

  function persist(next: PromptTemplate[]) {
    setLibrary({ owner: userId, templates: next });
    savePromptLibrary(userId, next);
  }

  function togglePin(id: string) {
    persist(
      templates.map((item) =>
        item.id === id ? { ...item, pinned: !item.pinned } : item,
      ),
    );
  }

  function remove(id: string) {
    persist(templates.filter((item) => item.id !== id));
  }

  function saveTemplate() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t("dashboard:ai.promptTemplateNameRequired"));
      return;
    }
    const draft = currentDraft();
    if (!draft.prompt.trim()) {
      setError(t("dashboard:ai.promptTemplateEmpty"));
      return;
    }
    setError(null);
    persist([
      {
        ...draft,
        id: randomUuid(),
        name: trimmed,
        pinned: false,
      },
      ...templates,
    ]);
    setName("");
  }

  const sorted = [...templates].sort(
    (left, right) => Number(right.pinned) - Number(left.pinned),
  );

  return (
    <Collapsible className="group/library rounded-lg border">
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="w-full justify-start px-4 py-3 font-normal"
        >
          <ChevronRight className="mr-2 h-4 w-4 shrink-0 transition-transform duration-200 group-data-[state=open]/library:rotate-90" />
          <BookMarked className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="font-bold">{t("dashboard:ai.promptLibrary")}</span>
          <span className="ml-2 text-sm text-muted-foreground">
            {t("dashboard:ai.promptLibraryCount", { total: templates.length })}
          </span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3 border-t p-4">
        <p className="text-sm text-muted-foreground">
          {t("dashboard:ai.promptLibraryDescription")}
        </p>
        {sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("dashboard:ai.promptLibraryEmpty")}
          </p>
        ) : (
          <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
            {sorted.map((item) => (
              <li key={item.id} className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 shrink-0 p-0"
                  aria-label={t("dashboard:ai.promptPin")}
                  aria-pressed={item.pinned}
                  onClick={() => togglePin(item.id)}
                >
                  {item.pinned ? (
                    <Pin className="h-4 w-4 fill-current" />
                  ) : (
                    <PinOff className="h-4 w-4 text-muted-foreground" />
                  )}
                </Button>
                {/* The name is the apply control: the template is only useful
                    once it is in the form, so selecting and applying are the
                    same action. */}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="min-w-0 flex-1 justify-start font-normal"
                  onClick={() => onApply(item)}
                  title={item.prompt}
                >
                  <span className="truncate">{item.name}</span>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 shrink-0 p-0 text-muted-foreground"
                  aria-label={t("dashboard:ai.delete")}
                  onClick={() => remove(item.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-2">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            // This field sits inside the form that starts a paid run, so the
            // browser's implicit submission would spend the user's allowance on
            // the gesture that means "save this template".
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              saveTemplate();
            }}
            placeholder={t("dashboard:ai.promptTemplateName")}
            aria-label={t("dashboard:ai.promptTemplateName")}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={saveTemplate}
          >
            {t("dashboard:ai.promptSaveTemplate")}
          </Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CollapsibleContent>
    </Collapsible>
  );
}
