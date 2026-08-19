"use client";

import { useTranslation } from "@beutl/ui/i18n-client";
import SubmitButton from "@beutl/ui/submit-button";
import { Alert, AlertDescription, AlertTitle } from "@beutl/ui/ui/alert";
import { Card } from "@beutl/ui/ui/card";
import { Checkbox } from "@beutl/ui/ui/checkbox";
import { Input } from "@beutl/ui/ui/input";
import { Label } from "@beutl/ui/ui/label";
import { Textarea } from "@beutl/ui/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@beutl/ui/ui/toggle-group";
import { ImageIcon } from "lucide-react";
import { useActionState, useState, type ChangeEvent } from "react";
import {
  AI_MAX_IMAGE_REFERENCES,
  AI_MAX_SEED,
  AI_MIN_SEED,
  MAX_AI_PROMPT_LENGTH,
  type AiImageAspectRatio,
} from "@beutl/core";
import { composePrompt } from "@/lib/ai-prompt";
import { generateImageAction } from "./actions";
import { PromptLibrary, type PromptTemplate } from "./prompt-library";
import {
  AdvancedOptions,
  AiAccessNotice,
  AiWorkspace,
  DownloadButton,
  IdempotencyKeyField,
  ModelSelect,
  ResultPanel,
  ResultShimmer,
  ShimmerImage,
  ResultPlaceholder,
  blockedReason,
  defaultModelId,
  downloadFromUrl,
  type AiAccess,
} from "./shared";

// Labels for the ratios the capabilities endpoint publishes; the list itself
// lives in @beutl/core.
const ASPECT_RATIOS: { value: AiImageAspectRatio; labelKey: string }[] = [
  { value: "16:9", labelKey: "landscape" },
  { value: "1:1", labelKey: "square" },
  { value: "9:16", labelKey: "portrait" },
  { value: "4:3", labelKey: "classic" },
  { value: "3:4", labelKey: "classicPortrait" },
  // GPT Image-1 takes these two and none of the four above, so leaving them out
  // left that model with nothing this screen could ask it for.
  { value: "3:2", labelKey: "photo" },
  { value: "2:3", labelKey: "photoPortrait" },
];

// What each registered model will accept, read from the provider. A model
// missing from this map states no restriction and keeps every option.
export type AiImageModelOptions = {
  aspectRatios: string[];
  transparentBackground: boolean;
  seed: boolean;
  maxReferenceImages: number;
};

// The options this screen offers, narrowed to one model. Derived on every
// render rather than corrected in state: switching to a model that cannot do
// 16:9 must not leave a stale 16:9 in a hidden field, which is what the server
// would then be charged for and refuse.
function optionsOf(
  capabilities: Record<string, AiImageModelOptions> | undefined,
  modelId: string,
) {
  const supported = capabilities?.[modelId];
  const aspectRatios = supported?.aspectRatios.length
    ? ASPECT_RATIOS.filter((option) =>
        supported.aspectRatios.includes(option.value),
      )
    : ASPECT_RATIOS;
  return {
    aspectRatios: aspectRatios.length > 0 ? aspectRatios : ASPECT_RATIOS,
    transparentBackground: supported?.transparentBackground ?? true,
    seed: supported?.seed ?? true,
    maxReferenceImages: supported?.maxReferenceImages ?? AI_MAX_IMAGE_REFERENCES,
  };
}


export function ImageGenerateForm({
  lang,
  access,
  capabilities,
}: {
  lang: string;
  access: AiAccess;
  // Resolved on the server; see imageModelOptions in the page.
  capabilities?: Record<string, AiImageModelOptions>;
}) {
  const { t } = useTranslation(lang);
  const [state, dispatch, isPending] = useActionState(generateImageAction, {
    success: false,
  });
  const [prompt, setPrompt] = useState("");
  const [style, setStyle] = useState("");
  const [composition, setComposition] = useState("");
  const [exclusions, setExclusions] = useState("");
  const models = access.models["image.generate"] ?? [];
  const [model, setModel] = useState(() => defaultModelId(models));
  const [aspectRatio, setAspectRatio] = useState<string>("16:9");
  const [transparent, setTransparent] = useState(false);
  const [referenceNames, setReferenceNames] = useState<string[]>([]);

  const options = optionsOf(capabilities, model);
  const ratio = options.aspectRatios.some((option) => option.value === aspectRatio)
    ? aspectRatio
    : options.aspectRatios[0]!.value;
  // Asking a model that cannot cut one for a transparent background is a
  // refusal; leaving it to the model is always fine.
  const transparentBackground = options.transparentBackground && transparent;

  const tooManyReferences = referenceNames.length > options.maxReferenceImages;

  const blocked = blockedReason(access, ["image.generate"]);
  // The same composition the action validates, so the counter measures what the
  // server will.
  const composedLength = composePrompt({
    main: prompt,
    style,
    composition,
    exclusions,
  }).length;

  // More than the model takes is refused by the server, so the field says so
  // here rather than after the reservation.
  function handleReferenceChange(event: ChangeEvent<HTMLInputElement>) {
    setReferenceNames([...(event.target.files ?? [])].map((file) => file.name));
  }

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
            {/* The advanced fields are folded into the same string the server
                measures, so counting this box alone promises room that is not
                there. */}
            <span
              className={`text-xs tabular-nums ${
                composedLength > MAX_AI_PROMPT_LENGTH
                  ? "text-destructive"
                  : "text-muted-foreground"
              }`}
            >
              {composedLength} / {MAX_AI_PROMPT_LENGTH}
            </span>
          </div>
          <Textarea
            id="generatePrompt"
            name="prompt"
            maxLength={MAX_AI_PROMPT_LENGTH}
            required
            rows={5}
            placeholder={t("dashboard:ai.promptPlaceholder")}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </div>

        <ModelSelect
          lang={lang}
          models={models}
          value={model}
          onChange={setModel}
        />

        <div className="flex flex-col space-y-1.5">
          <Label>{t("dashboard:ai.aspectRatio")}</Label>
          <ToggleGroup
            type="single"
            variant="outline"
            value={ratio}
            // Radix clears the value when the active item is pressed again.
            // A ratio is always required, so keep the last one.
            onValueChange={(next) => next && setAspectRatio(next)}
            className="grid grid-cols-3 gap-2 sm:grid-cols-5"
          >
            {options.aspectRatios.map((option) => (
              <ToggleGroupItem
                key={option.value}
                value={option.value}
                className="h-auto flex-col gap-0.5 py-3"
              >
                <span className="text-sm tabular-nums">{option.value}</span>
                <span className="text-xs text-muted-foreground">
                  {t(`dashboard:ai.aspects.${option.labelKey}`)}
                </span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <input type="hidden" name="aspectRatio" value={ratio} />
        </div>

        <div
          className={`flex flex-col space-y-1.5 ${
            options.maxReferenceImages > 0 ? "" : "hidden"
          }`}
        >
          <Label htmlFor="generateReference">
            {t("dashboard:ai.referenceImage")}
          </Label>
          <Input
            id="generateReference"
            name="reference"
            type="file"
            multiple={options.maxReferenceImages > 1}
            accept="image/png,image/jpeg,image/webp,image/gif"
            onChange={handleReferenceChange}
          />
          <p
            className={
              tooManyReferences
                ? "text-xs text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            {tooManyReferences
              ? t("dashboard:ai.referenceImageTooMany", {
                  maximum: options.maxReferenceImages,
                })
              : referenceNames.length > 0
                ? t("dashboard:ai.referenceImageSelected", {
                    name: referenceNames.join(", "),
                  })
                : t("dashboard:ai.referenceImageHint", {
                    maximum: options.maxReferenceImages,
                  })}
          </p>
        </div>

        {options.transparentBackground && (
          <div className="flex items-center gap-2">
            <Checkbox
              id="generateTransparent"
              checked={transparentBackground}
              onCheckedChange={(checked) => setTransparent(checked === true)}
            />
            <Label htmlFor="generateTransparent" className="font-normal">
              {t("dashboard:ai.transparentBackground")}
            </Label>
          </div>
        )}
        <input
          type="hidden"
          name="background"
          value={transparentBackground ? "transparent" : "auto"}
        />

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
          {/* Repeating a seed reproduces a result, which is what makes an
              iteration on a picture possible at all. */}
          <div className="flex flex-col space-y-1.5">
            <Label htmlFor="generateSeed">{t("dashboard:ai.seed")}</Label>
            <Input
              id="generateSeed"
              name="seed"
              disabled={!options.seed}
              type="number"
              inputMode="numeric"
              min={AI_MIN_SEED}
              max={AI_MAX_SEED}
              step={1}
              className="max-w-[12rem]"
            />
            <p className="text-xs text-muted-foreground">
              {t("dashboard:ai.seedHint")}
            </p>
          </div>
        </AdvancedOptions>

        {state.message && (
          <Alert variant="destructive">
            <AlertTitle>{t("error")}</AlertTitle>
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        )}

        <SubmitButton
          className="w-full"
          forceSpinner={isPending}
          disabled={blocked !== null || tooManyReferences || isPending}
        >
          {t("dashboard:ai.generate")}
        </SubmitButton>
      </form>
    </Card>
  );

  const result = isPending ? (
    <ResultShimmer label={t("dashboard:ai.processing")} />
  ) : state.success && state.url ? (
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
        <ShimmerImage
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
