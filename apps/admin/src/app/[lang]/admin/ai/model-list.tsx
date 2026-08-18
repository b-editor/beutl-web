"use client";

import { useCallback, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTranslation } from "@beutl/ui/i18n-client";
import { useToast } from "@beutl/ui/use-toast";
import { Button } from "@beutl/ui/ui/button";
import { Input } from "@beutl/ui/ui/input";
import { Badge } from "@beutl/ui/ui/badge";
import { Checkbox } from "@beutl/ui/ui/checkbox";
import { MAX_PRICE_UNITS, MIN_PRICE_UNITS } from "@beutl/core";
import {
  MAX_MODEL_DISPLAY_NAME_LENGTH,
  MAX_MODEL_SORT_ORDER,
} from "@/lib/ai-operation-model-changes";
import { removeAiOperationModel, saveAiOperationModel } from "./actions";

export type AiOperationModelRow = {
  operation: string;
  modelId: string;
  priceUnits: number;
  displayName: string | null;
  sortOrder: number;
  enabled: boolean;
};

// Each row is saved on its own, unlike the settings above: a row carries five
// fields, so a page-wide batch of them would run past the save cap, and adding
// a model is a single decision rather than part of a repricing.
type Draft = {
  modelId: string;
  displayName: string;
  priceUnits: string;
  sortOrder: string;
  enabled: boolean;
};

function draftOf(row: AiOperationModelRow): Draft {
  return {
    modelId: row.modelId,
    displayName: row.displayName ?? "",
    priceUnits: String(row.priceUnits),
    sortOrder: String(row.sortOrder),
    enabled: row.enabled,
  };
}

const EMPTY_DRAFT: Draft = {
  modelId: "",
  displayName: "",
  priceUnits: "",
  sortOrder: "0",
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
        <Field label={t("admin:ai.models.sortOrder")}>
          <Input
            type="number"
            min={0}
            max={MAX_MODEL_SORT_ORDER}
            step={1}
            value={draft.sortOrder}
            disabled={isPending}
            onChange={(e) => setDraft({ ...draft, sortOrder: e.target.value })}
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
  models,
}: {
  lang: string;
  operation: string;
  models: AiOperationModelRow[];
}) {
  const { t } = useTranslation(lang);
  const { toast } = useToast();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [adding, setAdding] = useState(false);

  const run = useCallback(
    (work: () => Promise<{ success: boolean; message?: string }>) => {
      startTransition(async () => {
        try {
          const result = await work();
          if (result.success) {
            toast({ title: t("admin:ai.models.saved") });
            setEditing(null);
            setAdding(false);
            router.refresh();
          } else {
            toast({
              title: t("admin:ai.models.saveFailed"),
              description: result.message,
              variant: "destructive",
            });
          }
        } catch (e) {
          toast({
            title: t("admin:ai.models.saveFailed"),
            description: e instanceof Error ? e.message : String(e),
            variant: "destructive",
          });
        }
      });
    },
    [toast, t, router],
  );

  const save = useCallback(
    (current: Draft) => {
      run(async () =>
        await saveAiOperationModel({
          operation,
          modelId: current.modelId.trim(),
          // The server treats an empty name as absent and shows the id.
          displayName: current.displayName.trim() || null,
          priceUnits: Number(current.priceUnits),
          sortOrder: Number(current.sortOrder),
          enabled: current.enabled,
        }),
      );
    },
    [operation, run],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">{t("admin:ai.models.title")}</h3>
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
            saveLabel={t("admin:ai.form.save")}
            onSave={() => save(draft)}
            onCancel={() => setEditing(null)}
            onDelete={() =>
              run(async () =>
                await removeAiOperationModel({
                  operation,
                  modelId: model.modelId,
                }),
              )
            }
          />
        ) : (
          <div
            key={model.modelId}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
          >
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
          onSave={() => save(draft)}
          onCancel={() => setAdding(false)}
        />
      )}
    </div>
  );
}
