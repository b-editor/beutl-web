"use client";

import { useCallback, useState, type ReactNode } from "react";
import { useTranslation } from "@beutl/ui/i18n-client";
import { Button } from "@beutl/ui/ui/button";
import { Input } from "@beutl/ui/ui/input";
import { Badge } from "@beutl/ui/ui/badge";
import { Checkbox } from "@beutl/ui/ui/checkbox";
import { MAX_PRICE_UNITS, MIN_PRICE_UNITS } from "@beutl/core";
import { MAX_MODEL_DISPLAY_NAME_LENGTH } from "@/lib/ai-operation-model-changes";
import { useAiModels, type AiModelRow } from "./settings-form";

// Nothing here writes to the server. Every button edits the draft the page
// holds, and the save bar commits the allowance and every operation's models
// together — an allowance saved before the model it was raised for is an
// operation nobody can start, and the reverse refuses the model until the
// allowance lands.
type Draft = {
  modelId: string;
  displayName: string;
  priceUnits: string;
  enabled: boolean;
};

function draftOf(row: AiModelRow): Draft {
  return {
    modelId: row.modelId,
    displayName: row.displayName ?? "",
    priceUnits: String(row.priceUnits),
    enabled: row.enabled,
  };
}

const EMPTY_DRAFT: Draft = {
  modelId: "",
  displayName: "",
  priceUnits: "",
  enabled: true,
};

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={`flex flex-col gap-1 ${className ?? ""}`}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function ModelEditor({
  lang,
  operation,
  draft,
  setDraft,
  isPending,
  onSave,
  onCancel,
  onDelete,
  saveLabel,
  isNew,
}: {
  lang: string;
  operation: string;
  draft: Draft;
  setDraft: (draft: Draft) => void;
  isPending: boolean;
  onSave: () => void;
  onCancel?: () => void;
  onDelete?: () => void;
  saveLabel: string;
  isNew: boolean;
}) {
  const { t } = useTranslation(lang);
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label={t("admin:ai.models.modelId")} className="lg:col-span-2">
          <Input
            value={draft.modelId}
            // The id is the row's identity: editing it in place would register
            // a second row rather than rename this one.
            disabled={isPending || !isNew}
            placeholder="provider/model"
            onChange={(e) => setDraft({ ...draft, modelId: e.target.value })}
          />
        </Field>
        <Field label={t("admin:ai.models.displayName")}>
          <Input
            value={draft.displayName}
            disabled={isPending}
            maxLength={MAX_MODEL_DISPLAY_NAME_LENGTH}
            placeholder={draft.modelId || "provider/model"}
            onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
          />
        </Field>
        <Field label={t("admin:ai.price")}>
          <Input
            type="number"
            min={MIN_PRICE_UNITS}
            max={MAX_PRICE_UNITS}
            step={1}
            value={draft.priceUnits}
            disabled={isPending}
            onChange={(e) => setDraft({ ...draft, priceUnits: e.target.value })}
          />
        </Field>
        <label className="flex items-end gap-2 pb-2">
          <Checkbox
            checked={draft.enabled}
            disabled={isPending}
            onCheckedChange={(checked) =>
              setDraft({ ...draft, enabled: checked === true })
            }
          />
          <span className="text-sm">{t("admin:ai.models.enabled")}</span>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={isPending} onClick={onSave}>
          {saveLabel}
        </Button>
        {onCancel && (
          <Button
            size="sm"
            variant="ghost"
            disabled={isPending}
            onClick={onCancel}
          >
            {t("admin:ai.models.cancel")}
          </Button>
        )}
        {onDelete && (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive"
            disabled={isPending}
            onClick={onDelete}
          >
            {t("admin:ai.models.remove")}
          </Button>
        )}
      </div>
      <code className="text-xs text-muted-foreground">{operation}</code>
    </div>
  );
}

export function AiOperationModels({
  lang,
  operation,
  economicsByModel,
}: {
  lang: string;
  operation: string;
  // What each model costs to run, rendered under its own row so the figures do
  // not have to be matched back to a model by eye.
  economicsByModel: Record<string, ReactNode>;
}) {
  const { t } = useTranslation(lang);
  const { models, changed, isPending, setModels } = useAiModels(operation);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [adding, setAdding] = useState(false);
  const defaultModelId = models.find((model) => model.enabled)?.modelId;

  const rowOf = (current: Draft): AiModelRow => ({
    modelId: current.modelId.trim(),
    // An empty name is absent, and the row then shows the id.
    displayName: current.displayName.trim() || null,
    priceUnits: Number(current.priceUnits),
    enabled: current.enabled,
  });

  const apply = useCallback(
    (next: AiModelRow[]) => {
      setModels(next);
      setEditing(null);
      setAdding(false);
    },
    [setModels],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">
            {t("admin:ai.models.title")}
            {changed && (
              <Badge className="ml-2" variant="secondary">
                {t("admin:ai.form.unsaved")}
              </Badge>
            )}
          </h3>
          <p className="text-xs text-muted-foreground">
            {models.length === 0
              ? t("admin:ai.models.emptyDescription")
              : t("admin:ai.models.description")}
          </p>
        </div>
        {!adding && (
          <Button
            size="sm"
            variant="outline"
            disabled={isPending}
            onClick={() => {
              setDraft(EMPTY_DRAFT);
              setEditing(null);
              setAdding(true);
            }}
          >
            {t("admin:ai.models.add")}
          </Button>
        )}
      </div>

      {models.map((model) =>
        editing === model.modelId ? (
          <ModelEditor
            key={model.modelId}
            lang={lang}
            operation={operation}
            draft={draft}
            setDraft={setDraft}
            isPending={isPending}
            isNew={false}
            saveLabel={t("admin:ai.models.apply")}
            onSave={() =>
              apply(
                models.map((row) =>
                  row.modelId === model.modelId ? rowOf(draft) : row,
                ),
              )
            }
            onCancel={() => setEditing(null)}
            onDelete={() =>
              apply(models.filter((row) => row.modelId !== model.modelId))
            }
          />
        ) : (
          <div key={model.modelId} className="rounded-lg border">
            <div className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">
                  {model.displayName ?? model.modelId}
                </span>
                {/* The id is already the label when no display name was given;
                    printing it twice reads as two different things. */}
                {model.displayName && (
                  <code className="text-xs text-muted-foreground">
                    {model.modelId}
                  </code>
                )}
                {model.modelId === defaultModelId && (
                  <Badge variant="default">
                    {t("admin:ai.models.default")}
                  </Badge>
                )}
                {!model.enabled && (
                  <Badge variant="outline">
                    {t("admin:ai.models.disabled")}
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm text-muted-foreground">
                  {t("admin:ai.models.priceValue", { units: model.priceUnits })}
                </span>
                {/* Only on a model a request could actually land on: the
                    default is the first selectable one. */}
                {model.enabled && model.modelId !== defaultModelId && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={isPending}
                    onClick={() =>
                      // First in the list is the default, and the rest keep
                      // their relative order.
                      apply([
                        model,
                        ...models.filter(
                          (row) => row.modelId !== model.modelId,
                        ),
                      ])
                    }
                  >
                    {t("admin:ai.models.makeDefault")}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isPending}
                  onClick={() => {
                    setAdding(false);
                    setDraft(draftOf(model));
                    setEditing(model.modelId);
                  }}
                >
                  {t("admin:ai.models.edit")}
                </Button>
              </div>
            </div>
            {economicsByModel[model.modelId]}
          </div>
        ),
      )}

      {adding && (
        <ModelEditor
          lang={lang}
          operation={operation}
          draft={draft}
          setDraft={setDraft}
          isPending={isPending}
          isNew
          saveLabel={t("admin:ai.models.add")}
          // A new model goes last: landing in front of the default would change
          // what every request that names no model runs on.
          onSave={() => apply([...models, rowOf(draft)])}
          onCancel={() => setAdding(false)}
        />
      )}
    </div>
  );
}
