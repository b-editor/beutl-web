"use client";

import {
  useCallback,
  useEffect,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { useTranslation } from "@beutl/ui/i18n-client";
import { Button } from "@beutl/ui/ui/button";
import { Input } from "@beutl/ui/ui/input";
import { Badge } from "@beutl/ui/ui/badge";
import { Checkbox } from "@beutl/ui/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@beutl/ui/ui/collapsible";
import { Separator } from "@beutl/ui/ui/separator";
import { ChevronRight, ExternalLink } from "lucide-react";
import { MAX_PRICE_UNITS, MIN_PRICE_UNITS } from "@beutl/core";
import { MAX_MODEL_DISPLAY_NAME_LENGTH } from "@/lib/ai-operation-model-changes";
import { isAiModelId, type AiUnitValue } from "@beutl/core";
import type { AiCostEstimate } from "@beutl/api";
import { AiOperationEconomicsPanel, type OfferAmount } from "./economics-panel";
import { lookupAiModelEconomics } from "./actions";
import { useAiModels, type AiModelRow } from "./settings-form";

type LookedUpEconomics = {
  estimate: AiCostEstimate | null;
  proOffer: OfferAmount;
  topUpUnitValue: AiUnitValue | null;
};

// What the row being typed would cost to run.
//
// The saved rows have these figures rendered on the server, but a model that
// only exists in the form has none: the provider's rate card is keyed by model
// id. Looking it up as the id settles is what makes the cost ratio available
// while the price is being chosen rather than after it is saved.
function useModelEconomics(operation: string, modelId: string) {
  const [economics, setEconomics] = useState<LookedUpEconomics | null>(null);
  const [isLoading, startLookup] = useTransition();
  const trimmed = modelId.trim();

  useEffect(() => {
    if (!isAiModelId(trimmed)) {
      setEconomics(null);
      return;
    }
    let current = true;
    // Half-typed ids would each cost a request; wait for the typing to stop.
    const timer = setTimeout(() => {
      startLookup(async () => {
        const result = await lookupAiModelEconomics({
          operation,
          modelId: trimmed,
        });
        if (!current) return;
        setEconomics(
          result.success && "estimate" in result
            ? (result as LookedUpEconomics & { success: true })
            : null,
        );
      });
    }, 400);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [operation, trimmed]);

  return { economics, isLoading };
}

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

// The provider's page for a model, which is where its capabilities and its
// real rate card are. Safe to interpolate: isAiModelId already restricts the id
// to characters that need no escaping in a path.
function openRouterUrl(modelId: string): string {
  return `https://openrouter.ai/${modelId}`;
}

function OpenRouterLink({
  lang,
  modelId,
}: {
  lang: string;
  modelId: string;
}) {
  const { t } = useTranslation(lang);
  return (
    <Button asChild size="sm" variant="ghost">
      <a
        href={openRouterUrl(modelId)}
        target="_blank"
        rel="noreferrer noopener"
        title={t("admin:ai.models.openRouter")}
      >
        <ExternalLink className="h-4 w-4" />
        <span className="sr-only">{t("admin:ai.models.openRouter")}</span>
      </a>
    </Button>
  );
}

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
        {isAiModelId(draft.modelId.trim()) && (
          <OpenRouterLink lang={lang} modelId={draft.modelId.trim()} />
        )}
      </div>
      <ModelEditorEconomics lang={lang} operation={operation} draft={draft} />
    </div>
  );
}

// The same figures the saved rows carry, following the fields as they are
// typed: what the allowance buys at this price, what the provider charges for
// this model, and what share of the revenue that is.
function ModelEditorEconomics({
  lang,
  operation,
  draft,
}: {
  lang: string;
  operation: string;
  draft: Draft;
}) {
  const { t } = useTranslation(lang);
  const { economics, isLoading } = useModelEconomics(operation, draft.modelId);
  const price = Number(draft.priceUnits);
  if (!Number.isSafeInteger(price) || price <= 0) {
    return null;
  }
  if (!economics) {
    return (
      <p className="text-xs text-muted-foreground">
        {isLoading
          ? t("admin:ai.economics.loading")
          : t("admin:ai.models.economicsPending")}
      </p>
    );
  }

  return (
    <div className="-mx-4 -mb-4 mt-1 overflow-hidden rounded-b-lg">
      <AiOperationEconomicsPanel
        lang={lang}
        operation={operation}
        // No saved row to read a price from while one is being typed.
        modelId=""
        priceUnits={price}
        livePrice={price}
        // Undefined would read as "still loading"; a lookup that came back
        // without a rate is a cost nobody knows.
        estimate={
          economics.estimate ?? {
            status: "unknown",
            reason: "provider_unavailable",
          }
        }
        proOffer={economics.proOffer}
        topUpUnitValue={economics.topUpUnitValue}
      />
    </div>
  );
}

export function AiOperationModels({
  lang,
  operation,
  title,
  economicsByModel,
  warningsByModel,
}: {
  lang: string;
  operation: string;
  title: string;
  // What each model costs to run, rendered under its own row so the figures do
  // not have to be matched back to a model by eye.
  economicsByModel: Record<string, ReactNode>;
  // Why a registered model cannot serve this operation, keyed by model id. A
  // model the provider will refuse every request for looks identical to a
  // working one here otherwise, and the failure only shows up as "the provider
  // errored" on the user's screen.
  warningsByModel?: Record<string, string>;
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

  const defaultModel = models.find((model) => model.enabled);

  return (
    // Collapsed to start: nine operations of rows and figures is more than any
    // one edit needs on screen, so the header carries what the section would
    // have shown at a glance — which model a request lands on, how many are on
    // offer, and whether it holds an unsaved edit.
    <Collapsible className="group/operation flex flex-col gap-3">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full flex-wrap items-center justify-between gap-2 rounded-lg px-2 py-1 text-left transition-colors hover:bg-accent/40"
        >
          <span className="flex items-center gap-2">
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]/operation:rotate-90" />
            <span className="text-lg font-semibold">{title}</span>
            {changed && (
              <Badge variant="secondary">{t("admin:ai.form.unsaved")}</Badge>
            )}
          </span>
          {/* The model name is placed rather than interpolated: i18next
              escapes interpolated values, and a model id is mostly slash. */}
          <span className="text-xs text-muted-foreground">
            {defaultModel ? (
              <>
                {defaultModel.displayName ?? defaultModel.modelId}
                {" · "}
                {t("admin:ai.models.summaryCount", { total: models.length })}
              </>
            ) : (
              t("admin:ai.models.summaryNone")
            )}
          </span>
        </button>
      </CollapsibleTrigger>
      <Separator />

      <CollapsibleContent className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
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
                <OpenRouterLink lang={lang} modelId={model.modelId} />
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
            {warningsByModel?.[model.modelId] && (
              <p className="text-xs text-destructive">
                {warningsByModel[model.modelId]}
              </p>
            )}
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
      </CollapsibleContent>
    </Collapsible>
  );
}
