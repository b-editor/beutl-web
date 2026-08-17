"use client";

import { useTranslation } from "@beutl/ui/i18n-client";
import SubmitButton from "@beutl/ui/submit-button";
import { Alert, AlertDescription, AlertTitle } from "@beutl/ui/ui/alert";
import { Card } from "@beutl/ui/ui/card";
import { Input } from "@beutl/ui/ui/input";
import { Label } from "@beutl/ui/ui/label";
import { Textarea } from "@beutl/ui/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@beutl/ui/ui/toggle-group";
import { ImageIcon } from "lucide-react";
import { useActionState, useState } from "react";
import { generateImageAction } from "./actions";
import { PromptLibrary, type PromptTemplate } from "./prompt-library";
import {
  AdvancedOptions,
  AiAccessNotice,
  AiWorkspace,
  DownloadButton,
  IdempotencyKeyField,
  ResultPanel,
  ResultPlaceholder,
  blockedReason,
  downloadFromUrl,
  type AiAccess,
} from "./shared";

const IMAGE_SIZES = [
  { value: "1024x1024", ratio: "square" },
  { value: "1024x1536", ratio: "portrait" },
  { value: "1536x1024", ratio: "landscape" },
] as const;

const MAX_PROMPT_LENGTH = 4000;

export function ImageGenerateForm({
  lang,
  access,
}: {
  lang: string;
  access: AiAccess;
}) {
  const { t } = useTranslation(lang);
  const [state, dispatch] = useActionState(generateImageAction, {
    success: false,
  });
  const [prompt, setPrompt] = useState("");
  const [style, setStyle] = useState("");
  const [composition, setComposition] = useState("");
  const [exclusions, setExclusions] = useState("");
  const [size, setSize] = useState<string>("1024x1024");

  const blocked = blockedReason(access, ["image.generate"]);

  function applyTemplate(template: PromptTemplate) {
    setPrompt(template.prompt);
    setStyle(template.style ?? "");
    setComposition(template.composition ?? "");
    setExclusions(template.exclusions ?? "");
  }

  const form = (
    <Card>
      <form action={dispatch} className="flex flex-col gap-4 p-6">
        <IdempotencyKeyField state={state} />
        <PromptLibrary
          lang={lang}
          onApply={applyTemplate}
          currentDraft={() => ({ prompt, style, composition, exclusions })}
        />

        <div className="flex flex-col space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <Label htmlFor="generatePrompt">{t("dashboard:ai.prompt")}</Label>
            <span className="text-xs tabular-nums text-muted-foreground">
              {prompt.length} / {MAX_PROMPT_LENGTH}
            </span>
          </div>
          <Textarea
            id="generatePrompt"
            name="prompt"
            maxLength={MAX_PROMPT_LENGTH}
            required
            rows={5}
            placeholder={t("dashboard:ai.promptPlaceholder")}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </div>

        <div className="flex flex-col space-y-1.5">
          <Label>{t("dashboard:ai.size")}</Label>
          <ToggleGroup
            type="single"
            variant="outline"
            value={size}
            // Radix clears the value when the active item is pressed again.
            // A size is always required, so keep the last one.
            onValueChange={(next) => next && setSize(next)}
            className="grid grid-cols-3"
          >
            {IMAGE_SIZES.map((option) => (
              <ToggleGroupItem
                key={option.value}
                value={option.value}
                className="h-auto flex-col gap-0.5 py-3"
              >
                <span className="text-sm">
                  {t(`dashboard:ai.aspects.${option.ratio}`)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {option.value}
                </span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <input type="hidden" name="size" value={size} />
        </div>

        <AdvancedOptions lang={lang}>
          <div className="flex flex-col space-y-1.5">
            <Label htmlFor="generateStyle">
              {t("dashboard:ai.promptStyle")}
            </Label>
            <Input
              id="generateStyle"
              name="style"
              maxLength={1000}
              value={style}
              onChange={(event) => setStyle(event.target.value)}
            />
          </div>
          <div className="flex flex-col space-y-1.5">
            <Label htmlFor="generateComposition">
              {t("dashboard:ai.promptComposition")}
            </Label>
            <Input
              id="generateComposition"
              name="composition"
              maxLength={1000}
              value={composition}
              onChange={(event) => setComposition(event.target.value)}
            />
          </div>
          <div className="flex flex-col space-y-1.5">
            <Label htmlFor="generateExclusions">
              {t("dashboard:ai.promptAvoid")}
            </Label>
            <Input
              id="generateExclusions"
              name="exclusions"
              maxLength={1000}
              value={exclusions}
              onChange={(event) => setExclusions(event.target.value)}
            />
          </div>
        </AdvancedOptions>

        {state.message && (
          <Alert variant="destructive">
            <AlertTitle>{t("error")}</AlertTitle>
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        )}

        {/* Stays inside the form: SubmitButton reads useFormStatus. */}
        <SubmitButton className="w-full" disabled={blocked !== null}>
          {t("dashboard:ai.generate")}
        </SubmitButton>
      </form>
    </Card>
  );

  const result =
    state.success && state.url ? (
      <ResultPanel
        title={t("dashboard:ai.generated")}
        actions={
          <DownloadButton
            label={t("dashboard:ai.download")}
            onDownload={() =>
              downloadFromUrl(state.url ?? "", state.fileName ?? "ai-image.png")
            }
          />
        }
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={state.url}
          alt={t("dashboard:ai.generated")}
          className="w-full rounded-lg border"
        />
      </ResultPanel>
    ) : (
      <ResultPlaceholder
        icon={ImageIcon}
        label={t("dashboard:ai.resultPlaceholderImage")}
      />
    );

  return (
    <div className="flex flex-col gap-4">
      {blocked && <AiAccessNotice lang={lang} reason={blocked} />}
      <AiWorkspace form={form} result={result} />
    </div>
  );
}
