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
import {
  MAX_MODEL_USAGE_PERCENT,
  MIN_MODEL_USAGE_PERCENT,
} from "@beutl/core";
import {
  DEFAULT_MODEL_PROVIDER,
  MAX_MODEL_DISPLAY_NAME_LENGTH,
} from "@/lib/ai-operation-model-changes";
import { isAiModelId } from "@beutl/core";
import { lookupAiModelCompatibility } from "./actions";
import { useAiModels, type AiModelRow } from "./settings-form";

type LookedUpCompatibility = {
  unsupported: boolean;
};

// Whether the provider/model pair being typed can run this operation. Kept
// separate from pricing: model rows no longer render economic projections.
function useModelCompatibility(
  operation: string,
  modelId: string,
  // Which provider's rate card to read. The same id can name a model at one
  // provider and nothing at the other, so this follows the row's own selection
  // rather than defaulting.
  provider: string,
) {
  const [compatibility, setCompatibility] =
    useState<LookedUpCompatibility | null>(null);
  const [isLoading, startLookup] = useTransition();
  const trimmed = modelId.trim();

  useEffect(() => {
    if (!isAiModelId(trimmed)) {
      setCompatibility(null);
      return;
    }
    let current = true;
    // Half-typed ids would each cost a request; wait for the typing to stop.
    const timer = setTimeout(() => {
      startLookup(async () => {
        const result = await lookupAiModelCompatibility({
          operation,
          modelId: trimmed,
          provider,
        });
        if (!current) return;
        setCompatibility(
          result.success && "unsupported" in result
            ? (result as LookedUpCompatibility & { success: true })
            : null,
        );
      });
    }, 400);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [operation, trimmed, provider]);

  return { compatibility, isLoading };
}

// Nothing here writes to the server. Every button edits the draft the page
// holds, and the save bar commits the allowance and every operation's models
// together — an allowance saved before the model it was raised for is an
// operation nobody can start, and the reverse refuses the model until the
// allowance lands.
type Draft = {
  modelId: string;
  provider: string;
  displayName: string;
  usagePercent: string;
  // Hidden compatibility value for a database column older Workers still read.
  priceUnits: string;
  enabled: boolean;
};

function draftOf(row: AiModelRow): Draft {
  return {
    modelId: row.modelId,
    provider: row.provider,
    displayName: row.displayName ?? "",
    usagePercent: String(row.usagePercent),
    priceUnits: String(row.priceUnits),
    enabled: row.enabled,
  };
}

const EMPTY_DRAFT: Draft = {
  modelId: "",
  provider: DEFAULT_MODEL_PROVIDER,
  displayName: "",
  usagePercent: "100",
  priceUnits: "1",
  enabled: true,
};

// The providers a row may name, and what to call them on screen. Kept here
// rather than read from the server: the list changes only when an adapter is
// written, and a select cannot offer one that does not exist yet anyway.
const PROVIDER_OPTIONS = [
  { id: "openrouter", label: "OpenRouter" },
  { id: "vercel-gateway", label: "Vercel AI Gateway" },
] as const;

// The provider's page for a model, which is where its capabilities and its
// real rate card are. Safe to interpolate: isAiModelId already restricts the id
// to characters that need no escaping in a path.
//
// The two providers address a model differently: OpenRouter's page is the whole
// `creator/model` id, the Gateway's is only the part after the slash.
function modelDetailUrl(provider: string, modelId: string): string | null {
  if (provider === "vercel-gateway") {
    const slug = modelId.split("/")[1];
    return slug ? `https://vercel.com/ai-gateway/models/${slug}` : null;
  }
  if (provider === "openrouter") return `https://openrouter.ai/${modelId}`;
  return null;
}

function ModelDetailLink({
  lang,
  provider,
  modelId,
}: {
  lang: string;
  provider: string;
  modelId: string;
}) {
  const { t } = useTranslation(lang);
  const href = modelDetailUrl(provider, modelId);
  if (!href) return null;
  const label = PROVIDER_OPTIONS.find((option) => option.id === provider)
    ?.label ?? provider;
  return (
    <Button asChild size="sm" variant="ghost">
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        title={`${t("admin:ai.models.openRouter")} (${label})`}
      >
        <ExternalLink className="h-4 w-4" />
        <span className="sr-only">
          {`${t("admin:ai.models.openRouter")} (${label})`}
        </span>
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
        <Field label={t("admin:ai.models.provider")}>
          <select
            className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
            value={draft.provider}
            // The model id remains the row's identity. Changing this field
            // deliberately re-routes that registration to another provider;
            // the transactional save validates the new pairing before it is
            // committed.
            disabled={isPending}
            onChange={(e) => setDraft({ ...draft, provider: e.target.value })}
          >
            {PROVIDER_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
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
        <Field label={t("admin:ai.models.usagePercent")}>
          <Input
            type="number"
            min={MIN_MODEL_USAGE_PERCENT}
            max={MAX_MODEL_USAGE_PERCENT}
            step={1}
            value={draft.usagePercent}
            disabled={isPending}
            onChange={(e) =>
              setDraft({ ...draft, usagePercent: e.target.value })
            }
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
          <ModelDetailLink
            lang={lang}
            provider={draft.provider}
            modelId={draft.modelId.trim()}
          />
        )}
      </div>
      <LookedUpModelCompatibility
        lang={lang}
        operation={operation}
        modelId={draft.modelId}
        provider={draft.provider}
      />
    </div>
  );
}

// Provider compatibility for a model that exists only in the local draft.
// Used while editing and after Apply: the server-rendered row still describes
// the saved provider until the page-level save refreshes it.
function LookedUpModelCompatibility({
  lang,
  operation,
  modelId,
  provider,
  messageClassName,
}: {
  lang: string;
  operation: string;
  modelId: string;
  provider: string;
  messageClassName?: string;
}) {
  const { t } = useTranslation(lang);
  const { compatibility, isLoading } = useModelCompatibility(
    operation,
    modelId,
    provider,
  );
  if (isLoading || !compatibility?.unsupported) return null;
  return (
    <p className={`text-xs text-destructive ${messageClassName ?? ""}`}>
      {t("admin:ai.models.unsupportedByProvider")}
    </p>
  );
}

export function AiOperationModels({
  lang,
  operation,
  title,
  warningsByModel,
}: {
  lang: string;
  operation: string;
  title: string;
  // Why a registered model cannot serve this operation, keyed by model id. A
  // model the provider will refuse every request for looks identical to a
  // working one here otherwise, and the failure only shows up as "the provider
  // errored" on the user's screen.
  warningsByModel?: Record<string, string>;
}) {
  const { t } = useTranslation(lang);
  const { models, savedModels, changed, isPending, setModels } =
    useAiModels(operation);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [adding, setAdding] = useState(false);
  const defaultModelId = models.find((model) => model.enabled)?.modelId;

  const rowOf = (current: Draft): AiModelRow => ({
    modelId: current.modelId.trim(),
    provider: current.provider,
    // An empty name is absent, and the row then shows the id.
    displayName: current.displayName.trim() || null,
    usagePercent: Number(current.usagePercent),
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
    // Collapsed to start: nine operations of model rows is more than any
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

      {models.map((model) => {
        const savedModel = savedModels.find(
          (candidate) => candidate.modelId === model.modelId,
        );
        // A newly added row also has no server preview. In both cases the
        // provider/model pair in the draft must be looked up on the client.
        const needsFreshProviderPreview =
          savedModel === undefined || savedModel.provider !== model.provider;
        return editing === model.modelId ? (
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
                  {t("admin:ai.models.usagePercentValue", {
                    percent: model.usagePercent,
                  })}
                </span>
                <ModelDetailLink
                  lang={lang}
                  provider={model.provider}
                  modelId={model.modelId}
                />
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
            {needsFreshProviderPreview ? (
              <LookedUpModelCompatibility
                key={`${model.modelId}:${model.provider}`}
                lang={lang}
                operation={operation}
                modelId={model.modelId}
                provider={model.provider}
                messageClassName="px-3 pb-3"
              />
            ) : (
              <>
                {warningsByModel?.[model.modelId] && (
                  <p className="text-xs text-destructive">
                    {warningsByModel[model.modelId]}
                  </p>
                )}
              </>
            )}
          </div>
        );
      })}

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
