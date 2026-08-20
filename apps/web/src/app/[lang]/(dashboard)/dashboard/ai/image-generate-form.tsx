"use client";

import { useTranslation } from "@beutl/ui/i18n-client";
import SubmitButton from "@beutl/ui/submit-button";
import { Alert, AlertDescription, AlertTitle } from "@beutl/ui/ui/alert";
import { Button } from "@beutl/ui/ui/button";
import { Card } from "@beutl/ui/ui/card";
import { Input } from "@beutl/ui/ui/input";
import { Label } from "@beutl/ui/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@beutl/ui/ui/select";
import { Textarea } from "@beutl/ui/ui/textarea";
import { Shimmer } from "@beutl/ui/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@beutl/ui/ui/toggle-group";
import { ImageIcon, X } from "lucide-react";
import {
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { randomUuid } from "@beutl/core";
import { MAX_AI_IMAGE_REFERENCES_TOTAL_BYTES } from "@beutl/api";
import {
  AI_IMAGE_BACKGROUNDS,
  AI_MAX_IMAGE_REFERENCES,
  formatBytes,
  AI_MAX_SEED,
  AI_MIN_SEED,
  MAX_AI_PROMPT_LENGTH,
  type AiImageAspectRatio,
  type AiImageBackground,
} from "@beutl/core";
import { composePrompt } from "@/lib/ai-prompt";
import { runAiStream } from "@/lib/ai-event-stream";
import { PromptLibrary, type PromptTemplate } from "./prompt-library";
import {
  AdvancedOptions,
  AiAccessNotice,
  AiWorkspace,
  DownloadButton,
  ModelSelect,
  ResultPanel,
  ResultShimmer,
  ShimmerImage,
  ResultPlaceholder,
  blockedReason,
  keepsIdempotencyKey,
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

// Naming every background here means adding one to @beutl/core without a label
// stops the build rather than showing the user a raw value.
const BACKGROUND_LABEL_KEYS: Record<AiImageBackground, string> = {
  auto: "dashboard:ai.backgroundAuto",
  opaque: "dashboard:ai.backgroundOpaque",
  transparent: "dashboard:ai.backgroundTransparent",
};

// What each registered model will accept, read from the provider. A model
// missing from this map states no restriction and keeps every option.
export type AiImageModelOptions = {
  aspectRatios: string[];
  backgrounds: string[];
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
  const backgrounds = supported?.backgrounds.length
    ? AI_IMAGE_BACKGROUNDS.filter((value) =>
        supported.backgrounds.includes(value),
      )
    : [...AI_IMAGE_BACKGROUNDS];
  return {
    aspectRatios: aspectRatios.length > 0 ? aspectRatios : ASPECT_RATIOS,
    // "auto" is always on offer: it is the shape that sends no field at all.
    backgrounds: backgrounds.length > 0 ? backgrounds : ["auto" as const],
    seed: supported?.seed ?? true,
    maxReferenceImages: supported?.maxReferenceImages ?? AI_MAX_IMAGE_REFERENCES,
    // 枚数とは別の上限。全部あわせてこの大きさまで。
    maxReferenceImagesTotalBytes: MAX_AI_IMAGE_REFERENCES_TOTAL_BYTES,
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
  const [isPending, setIsPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [generated, setGenerated] = useState<
    { url: string; fileName: string } | null
  >(null);
  // The rough version the model is working through, shown while it works. Only
  // some providers send any; the rest simply have none to show.
  const [preview, setPreview] = useState<string | null>(null);
  // Names this submission to the server. Kept when a run is cut off, because
  // asking again under the same name recovers what was already paid for.
  const [idempotencyKey, setIdempotencyKey] = useState(() => randomUuid());
  const [prompt, setPrompt] = useState("");
  const [style, setStyle] = useState("");
  const [composition, setComposition] = useState("");
  const [exclusions, setExclusions] = useState("");
  const models = access.models["image.generate"] ?? [];
  const [model, setModel] = useState(() => defaultModelId(models));
  const [aspectRatio, setAspectRatio] = useState<string>("16:9");
  const [background, setBackground] = useState<AiImageBackground>("auto");
  const [references, setReferences] = useState<File[]>([]);
  const referenceInput = useRef<HTMLInputElement>(null);

  const options = optionsOf(capabilities, model);
  const ratio = options.aspectRatios.some((option) => option.value === aspectRatio)
    ? aspectRatio
    : options.aspectRatios[0]!.value;
  // Asking for a background the model does not take is a refusal; leaving it to
  // the model is always fine.
  const chosenBackground = options.backgrounds.includes(background)
    ? background
    : "auto";

  const tooManyReferences = references.length > options.maxReferenceImages;
  // 1 枚ごとの上限とは別に、合計にも上限がある。送ってから 413 になるより先に
  // 画面で言う。
  const referencesTooLarge =
    references.reduce((total, file) => total + file.size, 0) >
      options.maxReferenceImagesTotalBytes;

  const blocked = blockedReason(
    access,
    ["image.generate"],
    (access.models["image.generate"] ?? []).length === 0,
  );
  // The same composition the action validates, so the counter measures what the
  // server will.
  const composedLength = composePrompt({
    main: prompt,
    style,
    composition,
    exclusions,
  }).length;

  // The input is what the form submits, so the list kept here is written back
  // into it. Without that, a second visit to the file dialog would replace the
  // first picture instead of adding to it, and picking several would be the
  // only way to send more than one.
  function applyReferences(files: File[]) {
    setReferences(files);
    const selection = new DataTransfer();
    for (const file of files) selection.items.add(file);
    if (referenceInput.current) referenceInput.current.files = selection.files;
  }

  // More than the model takes is refused by the server, so the field says so
  // here rather than after the reservation.
  function handleReferenceChange(event: ChangeEvent<HTMLInputElement>) {
    const picked = [...(event.target.files ?? [])];
    if (options.maxReferenceImages < 2) {
      applyReferences(picked);
      return;
    }
    const added = picked.filter(
      (file) =>
        !references.some(
          (existing) =>
            existing.name === file.name && existing.size === file.size,
        ),
    );
    applyReferences([...references, ...added]);
  }

  // Sent to the API rather than through a server action, because this screen
  // shows the picture as it is worked out and a server action can only answer
  // once, at the end.
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isPending || blocked !== null || tooManyReferences || referencesTooLarge) {
      return;
    }

    const body = new FormData(event.currentTarget);
    // What the form carries is what the endpoint reads, save for the model and
    // the shapes this screen settled from the model's own capabilities.
    body.set("prompt", composePrompt({ main: prompt, style, composition, exclusions }));
    body.set("aspectRatio", ratio);
    body.set("background", chosenBackground);
    if (model) body.set("model", model);
    body.delete("reference");
    for (const reference of references) body.append("reference[]", reference);

    setIsPending(true);
    setMessage(null);
    setPreview(null);
    try {
      const outcome = await runAiStream<{ url: string; fileName?: string }>(
        "images",
        {
          body,
          idempotencyKey,
          onEvent: (name, data) => {
            if (name !== "partial") return;
            const image = (data as { image?: unknown }).image;
            if (typeof image === "string") setPreview(image);
          },
        },
      );

      if (outcome.ok) {
        setGenerated({
          url: outcome.result.url,
          fileName: outcome.result.fileName ?? "ai-image.png",
        });
        setReferences([]);
        if (referenceInput.current) referenceInput.current.value = "";
        setIdempotencyKey(randomUuid());
        return;
      }

      setMessage(t(`api-errors:${outcome.errorCode}`));
      // A run that was cut off, one still going, or one whose paid result could
      // not be read may all be answered by asking again under the same name.
      // None of them is a settlement, so the name stays.
      if (!keepsIdempotencyKey(outcome.errorCode)) {
        setIdempotencyKey(randomUuid());
      }
    } catch {
      setMessage(t("api-errors:aiProviderError"));
    } finally {
      setIsPending(false);
      setPreview(null);
    }
  }

  function applyTemplate(template: PromptTemplate) {
    setPrompt(template.prompt);
    setStyle(template.style ?? "");
    setComposition(template.composition ?? "");
    setExclusions(template.exclusions ?? "");
  }

  const form = (
    <Card>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-6">
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
            ref={referenceInput}
            id="generateReference"
            name="reference"
            type="file"
            multiple={options.maxReferenceImages > 1}
            accept="image/png,image/jpeg,image/webp,image/gif"
            onChange={handleReferenceChange}
          />
          {references.length > 0 && (
            <ul className="flex flex-col gap-1">
              {references.map((file) => (
                <li
                  key={`${file.name}:${file.size}`}
                  className="flex items-center gap-2 rounded-md border px-2 py-1"
                >
                  <span className="truncate text-xs">{file.name}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-6 w-6 p-0"
                    aria-label={t("dashboard:ai.referenceImageRemove", {
                      name: file.name,
                    })}
                    onClick={() =>
                      applyReferences(
                        references.filter((entry) => entry !== file),
                      )
                    }
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p
            className={
              tooManyReferences || referencesTooLarge
                ? "text-xs text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            {tooManyReferences
              ? t("dashboard:ai.referenceImageTooMany", {
                  maximum: options.maxReferenceImages,
                })
              : referencesTooLarge
                ? t("dashboard:ai.referenceImagesTooLarge", {
                    maximum: formatBytes(options.maxReferenceImagesTotalBytes),
                  })
                : t("dashboard:ai.referenceImageHint", {
                    maximum: options.maxReferenceImages,
                  })}
          </p>
        </div>

        {options.backgrounds.length > 1 && (
          <div className="flex flex-col space-y-1.5">
            <Label htmlFor="generateBackground">
              {t("dashboard:ai.background")}
            </Label>
            <Select
              value={chosenBackground}
              onValueChange={(value) =>
                setBackground(value as AiImageBackground)
              }
            >
              <SelectTrigger id="generateBackground">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.backgrounds.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(BACKGROUND_LABEL_KEYS[value])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <input type="hidden" name="background" value={chosenBackground} />

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

        {message && (
          <Alert variant="destructive">
            <AlertTitle>{t("error")}</AlertTitle>
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}

        <SubmitButton
          className="w-full"
          forceSpinner={isPending}
          disabled={
            blocked !== null ||
            tooManyReferences ||
            referencesTooLarge ||
            isPending
          }
        >
          {t("dashboard:ai.generate")}
        </SubmitButton>
      </form>
    </Card>
  );

  const result = isPending ? (
    // The picture as far as the model has taken it, if it sends anything at
    // all; a wait with nothing to show is still a wait.
    preview ? (
      <ResultPanel title={t("dashboard:ai.generating")}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`data:image/png;base64,${preview}`}
          alt={t("dashboard:ai.generating")}
          className="w-full rounded-lg border"
        />
        <Shimmer className="h-8 w-full" />
      </ResultPanel>
    ) : (
      <ResultShimmer label={t("dashboard:ai.processing")} />
    )
  ) : generated ? (
      <ResultPanel
        title={t("dashboard:ai.generated")}
        actions={
          <DownloadButton
            label={t("dashboard:ai.download")}
            onDownload={() => downloadFromUrl(generated.url, generated.fileName)}
          />
        }
      >
        <ShimmerImage
          src={generated.url}
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
