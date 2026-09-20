"use client";

import { useTranslation } from "@beutl/ui/i18n-client";
import SubmitButton from "@beutl/ui/submit-button";
import { Alert, AlertDescription, AlertTitle } from "@beutl/ui/ui/alert";
import { Button } from "@beutl/ui/ui/button";
import { Card } from "@beutl/ui/ui/card";
import { Input } from "@beutl/ui/ui/input";
import { Label } from "@beutl/ui/ui/label";
import { Textarea } from "@beutl/ui/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@beutl/ui/ui/select";
import { Slider } from "@beutl/ui/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@beutl/ui/ui/toggle-group";
import {
  Clapperboard,
  Clock,
  FastForward,
  History,
  PersonStanding,
  WandSparkles,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  AI_VIDEO_DURATIONS_SECONDS,
  MAX_AI_PROMPT_LENGTH,
  MAX_AI_SOURCE_VIDEO_UPLOAD_BYTES,
  MAX_AI_VIDEO_FRAME_UPLOAD_BYTES,
  formatBytes,
} from "@beutl/core";
import { runAiRequest } from "@/lib/ai-request";
import {
  buildAiMotionVideoSubmission,
  buildAiSourceVideoSubmission,
} from "@/lib/ai-video-submit";
import { listSourceVideosAction, type AiSourceVideo } from "./actions";
import type { AiSourceVideoOperation } from "./video-options";
import type { AiVideoModelOptions } from "./video-form";
import {
  AiAccessNotice,
  AiWorkspace,
  ModelSelect,
  ResultPanel,
  ResultPlaceholder,
  ResultShimmer,
  blockedReason,
  blocksSubmit,
  canSubmitAiRequest,
  canSubmitModelRequest,
  correctedModelId,
  defaultModelId,
  isAiPromptWithinLimit,
  keepsIdempotencyKey,
  requestSignature,
  useAiRequestNames,
  useFileFingerprints,
  useHeldModelCapabilities,
  type AiAccess,
  type AiScreenModel,
} from "./shared";

/** Which of the three things to do with a video. */
export type AiVideoEditMode = "edit" | "extend" | "motion";

// Which edit to run decides what the form asks for and what it costs, so it is
// a visible choice rather than an item in a list the user has to open — the
// same shape image editing uses for its five tasks.
const MODES: readonly {
  mode: AiVideoEditMode;
  operation: AiSourceVideoOperation;
  icon: typeof WandSparkles;
}[] = [
  { mode: "edit", operation: "video.edit", icon: WandSparkles },
  { mode: "extend", operation: "video.extend", icon: FastForward },
  { mode: "motion", operation: "video.motion", icon: PersonStanding },
];

const MODE_OPERATIONS = MODES.map((entry) => entry.operation);

/** Where the video being worked on comes from. */
type SourceKind = "upload" | "job";

export type AiVideoEditScreenOptions = Record<
  AiSourceVideoOperation,
  {
    models: AiScreenModel[];
    modelOptions: Record<string, AiVideoModelOptions>;
  }
>;

type SubmitState = {
  success: boolean;
  message?: string;
  keepIdempotencyKey?: boolean;
  jobId?: string;
};

type VideoJobResponse = {
  jobId: string;
  status: "running" | "succeeded" | "failed";
};

function isVideoJobResponse(value: unknown): value is VideoJobResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.jobId === "string" &&
    record.jobId.length > 0 &&
    (record.status === "running" ||
      record.status === "succeeded" ||
      record.status === "failed")
  );
}

// The lengths the chosen model takes. Lengths are not a range — a model offers
// a handful of whole seconds and refuses everything between — so the slider
// steps through what is on offer.
function durationsOf(
  options: Record<string, AiVideoModelOptions> | undefined,
  modelId: string,
): number[] {
  const supported = options?.[modelId]?.durations;
  return supported?.length ? supported : [...AI_VIDEO_DURATIONS_SECONDS];
}

function nearestDuration(current: number, supported: number[]): number {
  let nearest = supported[0] ?? current;
  for (const candidate of supported) {
    if (Math.abs(candidate - current) < Math.abs(nearest - current)) {
      nearest = candidate;
    }
  }
  return nearest;
}

export function VideoEditForm({
  lang,
  userId,
  access,
  screens,
}: {
  lang: string;
  userId: string;
  access: AiAccess;
  screens: AiVideoEditScreenOptions;
}) {
  const { t } = useTranslation(lang);
  const [mode, setMode] = useState<AiVideoEditMode>("edit");
  const [state, setState] = useState<SubmitState>({ success: false });
  const [isPending, setIsPending] = useState(false);
  const submittingRef = useRef(false);
  const activeRequestRef = useRef<AbortController | null>(null);

  const [sourceKind, setSourceKind] = useState<SourceKind>("upload");
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [sources, setSources] = useState<AiSourceVideo[] | null>(null);
  const [sourceJobId, setSourceJobId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [extendDuration, setExtendDuration] = useState("5");
  const [motionDuration, setMotionDuration] = useState("5");
  const [characterImage, setCharacterImage] = useState<File | null>(null);
  const [orientation, setOrientation] = useState<"image" | "video">("video");
  const [quality, setQuality] = useState<"standard" | "pro">("standard");
  const [modelByMode, setModelByMode] = useState<
    Partial<Record<AiSourceVideoOperation, string>>
  >({});

  // One name space for the screen, with the mode inside the signature — the
  // same way image editing holds one name for five tasks. Splitting it per
  // operation would lose an uncollected request the moment the mode changed.
  const names = useAiRequestNames(userId, "video.edit");
  const operation =
    MODES.find((entry) => entry.mode === mode)?.operation ?? "video.edit";
  const screen = screens[operation];

  // A Server Action keeps running after its browser has reloaded because it has
  // no Request signal. This screen submits through the internal route instead;
  // aborting its fetch on navigation lets that route pass cancellation all the
  // way to the provider while the durable idempotency key stays recoverable.
  useEffect(() => {
    return () => activeRequestRef.current?.abort();
  }, []);

  // This account's finished videos, offered as an alternative to picking a
  // file. Read once: all three modes take the same list.
  useEffect(() => {
    let current = true;
    void listSourceVideosAction()
      .then((listed) => {
        if (current) setSources(listed);
      })
      .catch(() => {
        if (current) setSources([]);
      });
    return () => {
      current = false;
    };
  }, []);

  const models = useMemo(() => screen?.models ?? [], [screen]);
  const blocked = blockedReason(
    access,
    MODE_OPERATIONS,
    MODE_OPERATIONS.every(
      (candidate) => (access.models[candidate] ?? []).length === 0,
    ),
  );
  const keepsName =
    (state as { keepIdempotencyKey?: boolean }).keepIdempotencyKey === true;
  useEffect(() => {
    names.settle(keepsName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const model = modelByMode[operation] ?? defaultModelId(models);
  const heldCapabilities = useHeldModelCapabilities(
    screen?.modelOptions,
    names.heldRequestModels(),
    models.map((entry) => entry.id),
    names.heldRequestCapabilities(),
  );
  const durations = durationsOf(heldCapabilities, model);
  const duration = nearestDuration(
    Number(mode === "motion" ? motionDuration : extendDuration),
    durations,
  );

  // 選ばれた時に一度だけ読む。名前と大きさだけでは、中身の違う同名同サイズの
  // ものが同じ依頼に見え、片方が走っている間もう片方を始められない。送れないと
  // 分かっている大きさのものは読まない——名前には要らない。
  const sentSourceFile = sourceKind === "upload" ? sourceFile : null;
  const oversizedSource =
    sentSourceFile !== null &&
    sentSourceFile.size > MAX_AI_SOURCE_VIDEO_UPLOAD_BYTES;
  const sourceFiles = useMemo(
    () => (sentSourceFile && !oversizedSource ? [sentSourceFile] : []),
    [sentSourceFile, oversizedSource],
  );
  const { contents: sourceContents, reading: readingSource } =
    useFileFingerprints(sourceFiles, MAX_AI_SOURCE_VIDEO_UPLOAD_BYTES);

  const sentCharacterImage = mode === "motion" ? characterImage : null;
  const oversizedCharacter =
    sentCharacterImage !== null &&
    sentCharacterImage.size > MAX_AI_VIDEO_FRAME_UPLOAD_BYTES;
  const characterImages = useMemo(
    () => (sentCharacterImage && !oversizedCharacter ? [sentCharacterImage] : []),
    [sentCharacterImage, oversizedCharacter],
  );
  const { contents: characterContents, reading: readingCharacter } =
    useFileFingerprints(characterImages, MAX_AI_VIDEO_FRAME_UPLOAD_BYTES);

  const oversized = oversizedSource || oversizedCharacter;
  const reading = readingSource || readingCharacter;
  const trimmedPrompt = prompt.trim();
  const promptTooLong = !isAiPromptWithinLimit(trimmedPrompt.length);
  // An edit produces something as long as its source, so it names no length.
  // Counting one anyway would split the same request across two names.
  const sentDuration = mode === "edit" ? null : duration;
  const chosenSource = sources?.find((entry) => entry.jobId === sourceJobId);
  const hasSource =
    sourceKind === "upload" ? sentSourceFile !== null : sourceJobId !== "";

  const signature = oversized
    ? ""
    : requestSignature([
        mode,
        model,
        trimmedPrompt,
        // 素材そのもの。アップロードは中身で、生成済みはジョブの名前で見分ける
        // ——どちらも、選び直しただけで別の依頼になってはいけない。
        sourceKind,
        sourceKind === "job" ? sourceJobId : (sourceContents[0] ?? ""),
        sentDuration,
        mode === "motion" ? orientation : null,
        mode === "motion" ? quality : null,
        sentCharacterImage !== null,
        sentCharacterImage ? (characterContents[0] ?? "") : "",
      ]);

  useEffect(() => {
    if (names.ready && !reading && !oversized) void names.ensure(signature);
  }, [names.ready, names, reading, oversized, signature]);

  const holdsName = !oversized && names.holds(signature);
  const holdsSelectedModel =
    names.holdsModel(model) || names.hasRestoredModel(model);
  useEffect(() => {
    if (reading) return;
    const corrected = correctedModelId(models, model, holdsSelectedModel);
    if (corrected !== model) {
      setModelByMode((current) => ({ ...current, [operation]: corrected }));
    }
  }, [holdsSelectedModel, model, models, operation, reading]);

  const modelCanSubmit = canSubmitModelRequest(
    models,
    model,
    holdsSelectedModel,
    holdsName,
  );
  const needsCharacter = mode === "motion" && sentCharacterImage === null;
  const taskUnaffordable =
    blocked === null && !access.availability[operation];
  const submitBlocked =
    blocksSubmit(blocked, holdsName) ||
    oversized ||
    !modelCanSubmit ||
    !hasSource ||
    trimmedPrompt === "" ||
    needsCharacter;
  const canSubmit = canSubmitAiRequest({
    submitBlocked,
    hasTask: true,
    taskUnaffordable,
    taskHasNoModel: models.length === 0 && !holdsName,
    busy: isPending || reading || oversized,
  });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !canSubmit ||
      promptTooLong ||
      oversized ||
      !names.ready ||
      submittingRef.current
    ) {
      return;
    }

    submittingRef.current = true;
    setIsPending(true);
    const controller = new AbortController();
    activeRequestRef.current = controller;

    try {
      const idempotencyKey = await names.acquireAndCommit(
        signature,
        model,
        names.heldCapabilityFor(signature) ?? heldCapabilities?.[model] ?? null,
      );
      if (!idempotencyKey) return;

      const source =
        sourceKind === "upload"
          ? ({ kind: "file", file: sentSourceFile! } as const)
          : ({ kind: "job", jobId: sourceJobId } as const);
      const submission =
        mode === "motion"
          ? buildAiMotionVideoSubmission({
              prompt: trimmedPrompt,
              source,
              characterImage: sentCharacterImage!,
              durationSeconds: duration,
              orientation,
              quality,
              model,
            })
          : buildAiSourceVideoSubmission({
              mode,
              prompt: trimmedPrompt,
              source,
              durationSeconds: sentDuration,
              model,
            });

      const outcome = await runAiRequest<VideoJobResponse>(
        submission.operation,
        { body: submission.body, idempotencyKey, signal: controller.signal },
      );
      if (!outcome.ok) {
        setState({
          success: false,
          message: t(`api-errors:${outcome.errorCode}`),
          ...(keepsIdempotencyKey(outcome.errorCode)
            ? { keepIdempotencyKey: true }
            : {}),
        });
        return;
      }
      if (!isVideoJobResponse(outcome.result)) {
        setState({
          success: false,
          message: t("api-errors:aiRequestInterrupted"),
          keepIdempotencyKey: true,
        });
        return;
      }
      if (outcome.result.status === "failed") {
        setState({ success: false, message: t("api-errors:aiProviderError") });
        return;
      }
      setState({ success: true, jobId: outcome.result.jobId });
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error("AI video edit submission response was lost", error);
        setState({
          success: false,
          message: t("api-errors:aiRequestInterrupted"),
          keepIdempotencyKey: true,
        });
      }
    } finally {
      submittingRef.current = false;
      setIsPending(false);
      activeRequestRef.current = null;
    }
  }

  const form = (
    <Card className="flex flex-col gap-4 p-6">
      <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
        {/* The video being worked on comes first, the way the picture does on
            the image edit screen. It is either one chosen from disk or one this
            account already generated — never both, because the API charges for
            exactly one source. */}
        <div className="flex flex-col space-y-1.5">
          <Label>{t("dashboard:ai.sourceVideo")}</Label>
          <ToggleGroup
            type="single"
            variant="outline"
            value={sourceKind}
            onValueChange={(value) => {
              if (value === "upload" || value === "job") setSourceKind(value);
            }}
            className="grid grid-cols-1 gap-2 sm:grid-cols-2"
          >
            <ToggleGroupItem value="upload" className="justify-start gap-2">
              <Clapperboard className="h-4 w-4 shrink-0" />
              <span className="truncate">
                {t("dashboard:ai.sourceVideoUpload")}
              </span>
            </ToggleGroupItem>
            <ToggleGroupItem value="job" className="justify-start gap-2">
              <History className="h-4 w-4 shrink-0" />
              <span className="truncate">
                {t("dashboard:ai.sourceVideoGenerated")}
              </span>
            </ToggleGroupItem>
          </ToggleGroup>

          {sourceKind === "upload" ? (
            <>
              <Input
                id="sourceVideoFile"
                type="file"
                accept="video/mp4,video/webm"
                onChange={(event) =>
                  setSourceFile(event.target.files?.[0] ?? null)
                }
              />
              <p
                className={
                  oversizedSource
                    ? "text-xs text-destructive"
                    : "text-xs text-muted-foreground"
                }
              >
                {oversizedSource
                  ? t("dashboard:ai.sourceVideoTooLarge", {
                      maximum: formatBytes(MAX_AI_SOURCE_VIDEO_UPLOAD_BYTES),
                    })
                  : t("dashboard:ai.sourceVideoUploadHint", {
                      maximum: formatBytes(MAX_AI_SOURCE_VIDEO_UPLOAD_BYTES),
                    })}
              </p>
            </>
          ) : sources === null ? (
            <p className="text-xs text-muted-foreground">
              {t("dashboard:ai.sourceVideoLoading")}
            </p>
          ) : sources.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("dashboard:ai.sourceVideoNone")}
            </p>
          ) : (
            <Select value={sourceJobId} onValueChange={setSourceJobId}>
              <SelectTrigger id="sourceVideoJob">
                <SelectValue
                  placeholder={t("dashboard:ai.sourceVideoPlaceholder")}
                />
              </SelectTrigger>
              <SelectContent>
                {sources.map((source) => (
                  <SelectItem
                    key={source.jobId}
                    value={source.jobId}
                    hint={`${source.durationSeconds}s`}
                  >
                    {source.fileName ??
                      new Date(source.createdAt).toLocaleString(lang)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {/* An edit answers with something as long as its source, so the
              length is worth seeing before the request is paid for. */}
          {mode === "edit" && sourceKind === "job" && chosenSource && (
            <p className="text-xs text-muted-foreground">
              {t("dashboard:ai.sourceVideoEditLength", {
                seconds: chosenSource.durationSeconds,
              })}
            </p>
          )}
          {mode === "edit" && sourceKind === "upload" && (
            <p className="text-xs text-muted-foreground">
              {t("dashboard:ai.sourceVideoEditLengthUnknown")}
            </p>
          )}
        </div>

        {/* Which edit to run decides whether a length is asked for and what it
            costs, so it is a visible choice rather than a hidden one. */}
        <div className="flex flex-col space-y-1.5">
          <Label>{t("dashboard:ai.videoEditModeLabel")}</Label>
          <ToggleGroup
            type="single"
            variant="outline"
            value={mode}
            onValueChange={(value) => {
              if (value) setMode(value as AiVideoEditMode);
            }}
            // One per row on a phone: at two columns the longest label is
            // wider than the cell and truncates.
            className="grid grid-cols-1 gap-2 sm:grid-cols-3"
          >
            {MODES.map((entry) => (
              <ToggleGroupItem
                key={entry.mode}
                value={entry.mode}
                disabled={
                  blocked === null && !access.availability[entry.operation]
                }
                className="justify-start gap-2"
              >
                <entry.icon className="h-4 w-4 shrink-0" />
                <span className="truncate">
                  {t(`dashboard:ai.videoEditModes.${entry.mode}`)}
                </span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <p className="text-xs text-muted-foreground">
            {t(`dashboard:ai.videoEditModeHints.${mode}`)}
          </p>
          {taskUnaffordable && (
            <p className="text-sm text-destructive">
              {t("dashboard:ai.balanceExhaustedDescription")}
            </p>
          )}
          {models.length === 0 && (
            <p className="text-sm text-destructive">
              {t("dashboard:ai.operationUnavailableDescription")}
            </p>
          )}
        </div>

        <div className="flex flex-col space-y-1.5">
          <Label htmlFor="videoEditPrompt">{t("dashboard:ai.prompt")}</Label>
          <Textarea
            id="videoEditPrompt"
            value={prompt}
            rows={4}
            maxLength={MAX_AI_PROMPT_LENGTH}
            placeholder={t(`dashboard:ai.videoEditPrompts.${mode}`)}
            onChange={(event) => setPrompt(event.target.value)}
          />
          <p
            className={
              promptTooLong
                ? "text-xs text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            {trimmedPrompt.length} / {MAX_AI_PROMPT_LENGTH}
          </p>
        </div>

        {mode === "motion" && (
          <>
            <div className="flex flex-col space-y-1.5">
              <Label htmlFor="characterImage">
                {t("dashboard:ai.characterImage")}
              </Label>
              <Input
                id="characterImage"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) =>
                  setCharacterImage(event.target.files?.[0] ?? null)
                }
              />
              <p
                className={
                  oversizedCharacter
                    ? "text-xs text-destructive"
                    : "text-xs text-muted-foreground"
                }
              >
                {oversizedCharacter
                  ? t("dashboard:ai.referenceImageTooLarge", {
                      maximum: formatBytes(MAX_AI_VIDEO_FRAME_UPLOAD_BYTES),
                    })
                  : t("dashboard:ai.characterImageHint")}
              </p>
            </div>

            <div className="flex flex-col space-y-1.5">
              <Label htmlFor="motionOrientation">
                {t("dashboard:ai.motionOrientation")}
              </Label>
              <Select
                value={orientation}
                onValueChange={(value) =>
                  setOrientation(value === "image" ? "image" : "video")
                }
              >
                <SelectTrigger id="motionOrientation">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="video">
                    {t("dashboard:ai.motionOrientations.video")}
                  </SelectItem>
                  <SelectItem value="image">
                    {t("dashboard:ai.motionOrientations.image")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col space-y-1.5">
              <Label htmlFor="motionQuality">
                {t("dashboard:ai.motionQuality")}
              </Label>
              <Select
                value={quality}
                onValueChange={(value) =>
                  setQuality(value === "pro" ? "pro" : "standard")
                }
              >
                <SelectTrigger id="motionQuality">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="standard">
                    {t("dashboard:ai.motionQualities.standard")}
                  </SelectItem>
                  <SelectItem value="pro">
                    {t("dashboard:ai.motionQualities.pro")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </>
        )}

        {/* An edit has no length to choose: it answers with its source's. */}
        {mode !== "edit" && (
          <div className="flex flex-col space-y-1.5">
            <Label htmlFor="videoEditDuration">
              {mode === "extend"
                ? t("dashboard:ai.extendDuration")
                : t("dashboard:ai.duration")}
            </Label>
            <Slider
              id="videoEditDuration"
              min={0}
              max={Math.max(durations.length - 1, 0)}
              step={1}
              value={[Math.max(durations.indexOf(duration), 0)]}
              onValueChange={([index]) => {
                const picked = String(durations[index ?? 0] ?? duration);
                if (mode === "motion") setMotionDuration(picked);
                else setExtendDuration(picked);
              }}
            />
            <p className="text-xs text-muted-foreground">{duration}s</p>
          </div>
        )}

        <ModelSelect
          lang={lang}
          models={models}
          value={model}
          onChange={(id) =>
            setModelByMode((current) => ({ ...current, [operation]: id }))
          }
        />

        {state.message && (
          <Alert variant="destructive">
            <AlertTitle>{t("error")}</AlertTitle>
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        )}

        <SubmitButton
          className="w-full"
          forceSpinner={isPending}
          // 中身を読んでいる間は送らない。読み終える前に送ると、中身の分から
          // ないまま作った名前で課金され、読み終えた時点で名前が変わる。
          disabled={
            !names.ready ||
            submitBlocked ||
            promptTooLong ||
            oversized ||
            isPending ||
            reading
          }
        >
          {t("dashboard:ai.generate")}
        </SubmitButton>
      </form>
    </Card>
  );

  // Video outlives the request, so there is never an inline result to show.
  const result = isPending ? (
    <ResultShimmer label={t("dashboard:ai.processing")} />
  ) : state.success ? (
    <ResultPanel title={t("dashboard:ai.videoQueuedTitle")}>
      <p className="text-sm text-muted-foreground">
        {t("dashboard:ai.videoQueued")}
      </p>
      <Button asChild variant="outline" size="sm">
        <Link href={`/${lang}/dashboard/ai/jobs`} prefetch={false}>
          <History className="h-4 w-4" />
          {t("dashboard:ai.jobHistory")}
        </Link>
      </Button>
    </ResultPanel>
  ) : (
    <ResultPlaceholder
      icon={mode === "extend" ? Clock : Clapperboard}
      label={t("dashboard:ai.resultPlaceholderVideoEdit")}
    />
  );

  return (
    <div className="flex flex-col gap-6">
      {blocked && <AiAccessNotice lang={lang} reason={blocked} />}
      <AiWorkspace form={form} result={result} />
    </div>
  );
}
