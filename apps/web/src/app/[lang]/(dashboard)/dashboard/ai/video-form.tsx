"use client";

import { useTranslation } from "@beutl/ui/i18n-client";
import SubmitButton from "@beutl/ui/submit-button";
import { Alert, AlertDescription, AlertTitle } from "@beutl/ui/ui/alert";
import { Button } from "@beutl/ui/ui/button";
import { Card } from "@beutl/ui/ui/card";
import { Input } from "@beutl/ui/ui/input";
import { Label } from "@beutl/ui/ui/label";
import { Textarea } from "@beutl/ui/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@beutl/ui/ui/toggle-group";
import { Clapperboard, Clock, Coins, History } from "lucide-react";
import Link from "next/link";
import { useActionState, useEffect, useState, type ChangeEvent } from "react";
import {
  AI_MAX_SEED,
  AI_MIN_SEED,
  AI_VIDEO_ASPECT_RATIOS,
  AI_VIDEO_DURATIONS_SECONDS,
  AI_VIDEO_RESOLUTIONS,
  MAX_AI_PROMPT_LENGTH,
} from "@beutl/core";
import { composePrompt } from "@/lib/ai-prompt";
import { createVideoAction } from "./actions";
import { PromptLibrary, type PromptTemplate } from "./prompt-library";
import {
  AdvancedOptions,
  AiAccessNotice,
  ModelSelect,
  AiWorkspace,
  IdempotencyKeyField,
  ResultPanel,
  blockedReason,
  defaultModelId,
  type AiAccess,
} from "./shared";


function FramePicker({
  id,
  name,
  label,
  hint,
}: {
  id: string;
  name: string;
  label: string;
  hint: string;
}) {
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setPreview(file ? URL.createObjectURL(file) : null);
  }

  return (
    <div className="flex flex-col space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={name}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={handleChange}
      />
      <p className="text-xs text-muted-foreground">{hint}</p>
      {preview && (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={preview}
          alt={label}
          className="mt-1 max-w-[12rem] rounded-lg border"
        />
      )}
    </div>
  );
}

function Note({
  icon: Icon,
  children,
}: {
  icon: typeof Clock;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="text-sm text-muted-foreground">{children}</span>
    </li>
  );
}

export function VideoForm({
  lang,
  access,
}: {
  lang: string;
  access: AiAccess;
}) {
  const { t } = useTranslation(lang);
  const [state, dispatch] = useActionState(createVideoAction, {
    success: false,
  });
  const [videoDuration, setVideoDuration] = useState<string>("4");
  const [videoResolution, setVideoResolution] = useState<string>("720p");
  const [videoAspectRatio, setVideoAspectRatio] = useState<string>("16:9");
  const [generateAudio, setGenerateAudio] = useState(true);
  const [videoPrompt, setVideoPrompt] = useState("");
  const [videoStyle, setVideoStyle] = useState("");
  const [model, setModel] = useState(() =>
    defaultModelId(access.models["video.generate"] ?? []),
  );
  const [videoComposition, setVideoComposition] = useState("");
  const [videoMotion, setVideoMotion] = useState("");
  const [videoExclusions, setVideoExclusions] = useState("");

  const blocked = blockedReason(access, ["video.generate"]);
  const models = access.models["video.generate"] ?? [];
  // The same composition the action validates, so the counter measures what the
  // server will.
  const composedLength = composePrompt({
    main: videoPrompt,
    style: videoStyle,
    composition: videoComposition,
    motion: videoMotion,
    exclusions: videoExclusions,
  }).length;

  function applyTemplate(template: PromptTemplate) {
    setVideoPrompt(template.prompt);
    setVideoStyle(template.style ?? "");
    setVideoComposition(template.composition ?? "");
    setVideoMotion(template.motion ?? "");
    setVideoExclusions(template.exclusions ?? "");
  }

  const form = (
    <Card>
      <form action={dispatch} className="flex flex-col gap-4 p-6">
        <IdempotencyKeyField state={state} />
        <PromptLibrary
          lang={lang}
          onApply={applyTemplate}
          currentDraft={() => ({
            prompt: videoPrompt,
            style: videoStyle,
            composition: videoComposition,
            motion: videoMotion,
            exclusions: videoExclusions,
          })}
        />

        <div className="flex flex-col space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <Label htmlFor="videoPrompt">{t("dashboard:ai.prompt")}</Label>
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
            id="videoPrompt"
            name="prompt"
            maxLength={MAX_AI_PROMPT_LENGTH}
            required
            rows={5}
            placeholder={t("dashboard:ai.videoPromptPlaceholder")}
            value={videoPrompt}
            onChange={(event) => setVideoPrompt(event.target.value)}
          />
        </div>

        <ModelSelect
          lang={lang}
          models={models}
          value={model}
          onChange={setModel}
        />

        <div className="flex flex-col space-y-1.5">
          <Label>{t("dashboard:ai.duration")}</Label>
          <ToggleGroup
            type="single"
            variant="outline"
            value={videoDuration}
            onValueChange={(next) => next && setVideoDuration(next)}
            className="grid grid-cols-3"
          >
            {AI_VIDEO_DURATIONS_SECONDS.map((duration) => (
              <ToggleGroupItem key={duration} value={String(duration)}>
                {duration}s
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <input type="hidden" name="durationSeconds" value={videoDuration} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col space-y-1.5">
            <Label>{t("dashboard:ai.resolution")}</Label>
            <ToggleGroup
              type="single"
              variant="outline"
              value={videoResolution}
              onValueChange={(next) => next && setVideoResolution(next)}
              className="grid grid-cols-2"
            >
              {AI_VIDEO_RESOLUTIONS.map((resolution) => (
                <ToggleGroupItem key={resolution} value={resolution}>
                  {resolution}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <input type="hidden" name="resolution" value={videoResolution} />
          </div>

          {/* Resolution alone could not express a vertical clip. */}
          <div className="flex flex-col space-y-1.5">
            <Label>{t("dashboard:ai.aspectRatio")}</Label>
            <ToggleGroup
              type="single"
              variant="outline"
              value={videoAspectRatio}
              onValueChange={(next) => next && setVideoAspectRatio(next)}
              className="grid grid-cols-2"
            >
              {AI_VIDEO_ASPECT_RATIOS.map((ratio) => (
                <ToggleGroupItem key={ratio} value={ratio}>
                  {ratio}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <input type="hidden" name="aspectRatio" value={videoAspectRatio} />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <input
            id="videoAudio"
            type="checkbox"
            className="h-4 w-4 rounded border-input accent-primary"
            checked={generateAudio}
            onChange={(event) => setGenerateAudio(event.target.checked)}
          />
          <Label htmlFor="videoAudio" className="font-normal">
            {t("dashboard:ai.generateAudio")}
          </Label>
          <input
            type="hidden"
            name="generateAudio"
            value={generateAudio ? "true" : "false"}
          />
        </div>

        <AdvancedOptions lang={lang}>
          <div className="flex flex-col space-y-1.5">
            <Label htmlFor="videoSeed">{t("dashboard:ai.seed")}</Label>
            <Input
              id="videoSeed"
              name="seed"
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
          <div className="flex flex-col space-y-1.5">
            <Label htmlFor="videoStyle">{t("dashboard:ai.promptStyle")}</Label>
            <Input
              id="videoStyle"
              name="style"
              maxLength={1000}
              value={videoStyle}
              onChange={(event) => setVideoStyle(event.target.value)}
            />
          </div>
          <div className="flex flex-col space-y-1.5">
            <Label htmlFor="videoComposition">
              {t("dashboard:ai.promptComposition")}
            </Label>
            <Input
              id="videoComposition"
              name="composition"
              maxLength={1000}
              value={videoComposition}
              onChange={(event) => setVideoComposition(event.target.value)}
            />
          </div>
          <div className="flex flex-col space-y-1.5">
            <Label htmlFor="videoMotion">{t("dashboard:ai.promptMotion")}</Label>
            <Input
              id="videoMotion"
              name="motion"
              maxLength={1000}
              value={videoMotion}
              onChange={(event) => setVideoMotion(event.target.value)}
            />
          </div>
          <div className="flex flex-col space-y-1.5">
            <Label htmlFor="videoExclusions">
              {t("dashboard:ai.promptAvoid")}
            </Label>
            <Input
              id="videoExclusions"
              name="exclusions"
              maxLength={1000}
              value={videoExclusions}
              onChange={(event) => setVideoExclusions(event.target.value)}
            />
          </div>
          <FramePicker
            id="videoFirstFrame"
            name="firstFrame"
            label={t("dashboard:ai.firstFrame")}
            hint={t("dashboard:ai.firstFrameHint")}
          />
          <FramePicker
            id="videoLastFrame"
            name="lastFrame"
            label={t("dashboard:ai.lastFrame")}
            hint={t("dashboard:ai.lastFrameHint")}
          />
        </AdvancedOptions>

        {state.message && (
          <Alert variant="destructive">
            <AlertTitle>{t("error")}</AlertTitle>
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        )}

        <SubmitButton className="w-full" disabled={blocked !== null}>
          {t("dashboard:ai.generate")}
        </SubmitButton>
      </form>
    </Card>
  );

  // Video outlives the request, so there is never an inline result to show.
  // The right column carries what the user needs to know before pressing
  // generate, and where the finished clip will turn up afterwards.
  const result = state.success ? (
    <ResultPanel title={t("dashboard:ai.videoQueuedTitle")}>
      <p className="text-sm text-muted-foreground">
        {t("dashboard:ai.videoQueued")}
      </p>
      <Button asChild variant="outline" size="sm" className="self-start">
        <Link href={`/${lang}/dashboard/ai/jobs`}>
          <History className="mr-2 h-4 w-4" />
          {t("dashboard:ai.jobHistory")}
        </Link>
      </Button>
    </ResultPanel>
  ) : (
    <Card className="flex flex-col gap-3 p-4">
      <p className="inline-flex items-center gap-2 font-bold">
        <Clapperboard className="h-4 w-4 text-muted-foreground" />
        {t("dashboard:ai.videoFlowTitle")}
      </p>
      <ul className="flex flex-col gap-3">
        <Note icon={Coins}>{t("dashboard:ai.videoDurationNotice")}</Note>
        <Note icon={Clock}>{t("dashboard:ai.videoFlowDuration")}</Note>
        <Note icon={History}>{t("dashboard:ai.videoFlowHistory")}</Note>
      </ul>
    </Card>
  );

  return (
    <div className="flex flex-col gap-4">
      {blocked && <AiAccessNotice lang={lang} reason={blocked} />}
      <AiWorkspace form={form} result={result} />
    </div>
  );
}
