"use client";

import { useTranslation } from "@beutl/ui/i18n-client";
import SubmitButton from "@beutl/ui/submit-button";
import { Alert, AlertDescription, AlertTitle } from "@beutl/ui/ui/alert";
import { Button } from "@beutl/ui/ui/button";
import { Card } from "@beutl/ui/ui/card";
import { Checkbox } from "@beutl/ui/ui/checkbox";
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
import { Clapperboard, Clock, Coins, History } from "lucide-react";
import Link from "next/link";
import {
  useActionState,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import {
  AI_MAX_SEED,
  AI_MIN_SEED,
  AI_VIDEO_ASPECT_RATIOS,
  AI_VIDEO_DURATIONS_SECONDS,
  AI_VIDEO_RESOLUTIONS,
  MAX_AI_PROMPT_LENGTH,
} from "@beutl/core";
import { MAX_AI_VIDEO_FRAME_UPLOAD_BYTES } from "@beutl/api";
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
  ResultShimmer,
  blockedReason,
  blocksSubmit,
  canSubmitAiRequest,
  requestSignature,
  seedValue,
  useFileFingerprints,
  useAiRequestNames,
  defaultModelId,
  type AiAccess,
} from "./shared";


function FramePicker({
  id,
  name,
  label,
  hint,
  file,
  onPick,
  clearLabel,
  note = null,
}: {
  id: string;
  name: string;
  label: string;
  hint: string;
  // 選ばれている絵そのもの。欄ではなくここが持ち主——欄はモデルの都合で画面から
  // 外れ、外れれば選ばれていたものを忘れる。画面から消えても依頼は消えないので、
  // 戻ってきたときに見せるのはこちら。
  file: File | null;
  // どのフレームが選ばれているかは、依頼の一部。画面がそれを知らないと、
  // フレームだけ差し替えた依頼が前の依頼と同じ名前で送られ、断られる。
  onPick: (file: File | null) => void;
  clearLabel: string;
  // 選ばれてはいるが、いまのままでは送らない——その理由。黙って落とすと、画面に
  // 見えている条件と、買うものが食い違う。
  note?: string | null;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  // 外したときに欄そのものを作り直すための番号。欄はブラウザが持っていて、
  // こちらからは空にできない——番号を変えて作り直すのが、選び直せる状態に
  // 戻す唯一の方法。
  const [pickerGeneration, setPickerGeneration] = useState(0);

  // 見せているものを、持っているものに合わせる。欄が空でも持ち主が覚えていれば
  // それを見せる——見えないまま送られるのは、画面が嘘をついているのと同じ。
  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }

    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    onPick(event.target.files?.[0] ?? null);
  }

  return (
    <div className="flex flex-col space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        key={pickerGeneration}
        id={id}
        name={name}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={handleChange}
      />
      <p className="text-xs text-muted-foreground">{hint}</p>
      {note && <p className="text-xs text-destructive">{note}</p>}
      {file && (
        <div className="flex items-center gap-2">
          <p className="text-xs text-muted-foreground">{file.name}</p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              onPick(null);
              setPickerGeneration((current) => current + 1);
            }}
          >
            {clearLabel}
          </Button>
        </div>
      )}
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

// What each registered model will accept, read from the provider. A model
// missing from this map states no restriction and keeps every option.
export type AiVideoModelOptions = {
  resolutions: string[];
  durations: number[];
  aspectRatios: string[];
  generateAudio: boolean;
  seed: boolean;
  firstFrame: boolean;
  lastFrame: boolean;
};

// The options this screen offers, narrowed to one model. Values are derived on
// every render rather than corrected in state: switching to a model that cannot
// do 1080p must not leave a stale 1080p in a hidden field, which is what the
// server would then be charged for and refuse.
function optionsOf(
  capabilities: Record<string, AiVideoModelOptions> | undefined,
  modelId: string,
) {
  const supported = capabilities?.[modelId];
  return {
    durations: supported?.durations.length
      ? supported.durations
      : [...AI_VIDEO_DURATIONS_SECONDS],
    resolutions: supported?.resolutions.length
      ? supported.resolutions
      : [...AI_VIDEO_RESOLUTIONS],
    aspectRatios: supported?.aspectRatios.length
      ? supported.aspectRatios
      : [...AI_VIDEO_ASPECT_RATIOS],
    generateAudio: supported?.generateAudio ?? true,
    seed: supported?.seed ?? true,
    firstFrame: supported?.firstFrame ?? true,
    lastFrame: supported?.lastFrame ?? true,
  };
}

// The length nearest the one asked for that the model actually takes. Lengths
// are not a range: Veo 3.1 takes 4, 6 or 8 seconds and nothing between, so the
// slider steps through what is on offer rather than over seconds.
function nearestDuration(current: number, supported: number[]): number {
  let nearest = supported[0] ?? current;
  for (const candidate of supported) {
    if (Math.abs(candidate - current) < Math.abs(nearest - current)) {
      nearest = candidate;
    }
  }
  return nearest;
}

function firstSupported<T>(current: T, supported: T[]): T {
  return supported.includes(current) ? current : (supported[0] as T);
}

export function VideoForm({
  lang,
  access,
  capabilities,
}: {
  lang: string;
  access: AiAccess;
  capabilities?: Record<string, AiVideoModelOptions>;
}) {
  const { t } = useTranslation(lang);
  const [state, dispatch, isPending] = useActionState(createVideoAction, {
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
  const [videoSeed, setVideoSeed] = useState("");
  const [firstFrame, setFirstFrame] = useState<File | null>(null);
  const [lastFrame, setLastFrame] = useState<File | null>(null);

  const models = access.models["video.generate"] ?? [];
  const names = useAiRequestNames();
  const blocked = blockedReason(access, ["video.generate"], models.length === 0);
  // 直前の失敗が名前を残していれば、残高で塞がない。支払い済みの結果を取りに
  // 行く道を閉じることになる。
  const keepsName =
    (state as { keepIdempotencyKey?: boolean }).keepIdempotencyKey === true;
  useEffect(() => {
    names.settle(keepsName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  const options = optionsOf(capabilities, model);
  const duration = nearestDuration(Number(videoDuration), options.durations);
  const resolution = firstSupported(videoResolution, options.resolutions);
  const aspectRatio = firstSupported(videoAspectRatio, options.aspectRatios);
  // A model that cannot produce sound would refuse the request outright.
  const audio = options.generateAudio && generateAudio;
  // 選ばれた時に一度だけ読む。名前と大きさだけでは、中身の違う同名同サイズの絵が
  // 同じ依頼に見え、片方が走っている間もう片方を始められない。
  const frames = useMemo(
    () => [firstFrame, lastFrame].filter((frame): frame is File => frame !== null),
    [firstFrame, lastFrame],
  );
  const { contents: frameContents, reading: readingFrames } =
    useFileFingerprints(frames, MAX_AI_VIDEO_FRAME_UPLOAD_BYTES);
  // 実際に送るフレーム。モデルが取らないものは送らず、終わりのフレームは始まり
  // があるときだけ送る——この API に始まりの無い依頼は無い。名前もここから
  // 作るので、画面に見えている条件と、その名前で買うものが食い違わない。
  const sentFirstFrame = options.firstFrame ? firstFrame : null;
  const sentLastFrame =
    sentFirstFrame && options.lastFrame ? lastFrame : null;
  const firstFrameContent = firstFrame ? frameContents[0] ?? "" : "";
  const lastFrameContent = lastFrame
    ? frameContents[firstFrame ? 1 : 0] ?? ""
    : "";
  // サーバーが指紋を取るのと同じものから、こちらで見えるぶんだけ。文章はここに
  // ある材料から組み立てられるので、材料をそのまま数える。種とフレームは入力欄
  // の中にあって描画のたびには読めない——そのぶんこの署名は粗く、粗いほうへ
  // 外れるのは安全側だ。同じ名前で別の依頼が届けば断られるだけで、同じ依頼が
  // 二つの名前に割れて二度課金されることはない。
  const signature = requestSignature([
    model,
    // 送るのは組み立てたあとの一本の文章。材料をそのまま数えると、前後の空白の
    // ちがいだけで別の名前になり、サーバーには同じ依頼が二度届いて二度課金
    // される。
    composePrompt({
      main: videoPrompt,
      style: videoStyle,
      composition: videoComposition,
      motion: videoMotion,
      exclusions: videoExclusions,
    }),
    duration,
    resolution,
    aspectRatio,
    // 送るのはモデルの都合を通したあとの値。押した状態そのままを数えると、音を
    // 出せないモデルでは同じ依頼が別の名前になり、二度課金される。
    audio,
    // 欄に書かれたままではなく、サーバーが読み取るのと同じ数。"1"、"01"、
    // "1.0" はどれも同じ種で、そのまま数えると同じ依頼が三つの名前に割れる。
    options.seed ? seedValue(videoSeed) : null,
    // フレームは中身と、あるかないかだけ。サーバーはその名前を見ない——名前を
    // 数えると、同じ一枚を別の名前で選び直しただけで別の依頼になり、支払い済み
    // のものへ戻れないまま二度課金される。
    //
    // 数えるのは送るものだけ。選ばれていても送らないフレームを数えると、画面に
    // 見えている条件と、その名前で買うものが食い違う。
    sentFirstFrame !== null,
    sentFirstFrame ? firstFrameContent : "",
    sentLastFrame !== null,
    sentLastFrame ? lastFrameContent : "",
  ]);
  // いま画面にある依頼の名前を持っているか。直前の応答が決着していても、
  // 別の依頼の名前はまだ手元にある——そちらへ戻ったときに残高で塞ぐと、
  // 支払い済みの結果を取りに行く道が閉じる。
  const holdsName = names.holds(signature);
  const submitBlocked = blocksSubmit(blocked, holdsName);
  const canSubmit = canSubmitAiRequest({
    submitBlocked,
    hasTask: true,
    taskUnaffordable: false,
    taskHasNoModel: models.length === 0 && !holdsName,
    // 中身を読んでいる間は送らない。読み終える前に送ると、中身の分からないまま
    // 作った名前で課金され、読み終えた時点で名前が変わってしまう。
    busy: isPending || readingFrames,
  });
  // The same composition the action validates, so the counter measures what the
  // server will.
  const composedLength = composePrompt({
    main: videoPrompt,
    style: videoStyle,
    composition: videoComposition,
    motion: videoMotion,
    exclusions: videoExclusions,
  }).length;

  // 送るものを、名乗ったものに合わせる。フレームの入力欄はモデルの都合で画面
  // から外れ、外れた時点で選ばれていたファイルは欄ごと消える——画面の状態だけ
  // が残り、名前は「フレームあり」と言いながらフレームの無い本文が出ていく。
  // 欄ではなく画面の状態から組み立てれば、その食い違いは起きない。
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // ボタンとキーボード送信で同じ答えを使う。片方だけを見ていると、入力欄で
    // Enter を押したときにボタンが断っているはずの依頼が出ていく。
    if (!canSubmit) return;

    const formData = new FormData(event.currentTarget);
    formData.delete("firstFrame");
    formData.delete("lastFrame");
    if (sentFirstFrame) formData.set("firstFrame", sentFirstFrame);
    if (sentLastFrame) formData.set("lastFrame", sentLastFrame);

    names.commit(signature);
    dispatch(formData);
  }

  function applyTemplate(template: PromptTemplate) {
    setVideoPrompt(template.prompt);
    setVideoStyle(template.style ?? "");
    setVideoComposition(template.composition ?? "");
    setVideoMotion(template.motion ?? "");
    setVideoExclusions(template.exclusions ?? "");
  }

  const form = (
    <Card>
      <form
        action={dispatch}
        onSubmit={handleSubmit}
        className="flex flex-col gap-4 p-6"
      >
        <IdempotencyKeyField name={names.nameFor(signature)} />
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
          <div className="flex items-baseline justify-between gap-2">
            <Label htmlFor="videoDuration">{t("dashboard:ai.duration")}</Label>
            <span className="text-xs tabular-nums text-muted-foreground">
              {t("dashboard:ai.durationSeconds", { seconds: duration })}
            </span>
          </div>
          {/* Stepped over the lengths on offer rather than over seconds: a
              model that takes 4, 6 or 8 has nothing at 5, and one that takes
              anything from 4 to 30 should not need thirty buttons. */}
          <Slider
            id="videoDuration"
            min={0}
            max={Math.max(options.durations.length - 1, 0)}
            step={1}
            value={[Math.max(options.durations.indexOf(duration), 0)]}
            disabled={options.durations.length <= 1}
            onValueChange={([index]) => {
              const next = options.durations[index ?? 0];
              if (next !== undefined) setVideoDuration(String(next));
            }}
          />
          <p className="text-xs text-muted-foreground">
            {t("dashboard:ai.durationRange", {
              min: options.durations[0] ?? duration,
              max: options.durations[options.durations.length - 1] ?? duration,
            })}
          </p>
          <input type="hidden" name="durationSeconds" value={duration} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col space-y-1.5">
            <Label htmlFor="videoResolution">
              {t("dashboard:ai.resolution")}
            </Label>
            {/* Left enabled with one entry: a greyed-out box reads as a
                setting that is unavailable rather than one that is fixed. */}
            <Select value={resolution} onValueChange={setVideoResolution}>
              <SelectTrigger id="videoResolution">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.resolutions.map((supported) => (
                  <SelectItem key={supported} value={supported}>
                    {supported}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <input type="hidden" name="resolution" value={resolution} />
          </div>

          {/* Resolution alone could not express a vertical clip. */}
          <div className="flex flex-col space-y-1.5">
            <Label htmlFor="videoAspectRatio">
              {t("dashboard:ai.aspectRatio")}
            </Label>
            <Select value={aspectRatio} onValueChange={setVideoAspectRatio}>
              <SelectTrigger id="videoAspectRatio">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.aspectRatios.map((ratio) => (
                  <SelectItem key={ratio} value={ratio}>
                    {ratio}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <input type="hidden" name="aspectRatio" value={aspectRatio} />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id="videoAudio"
            checked={audio}
            disabled={!options.generateAudio}
            onCheckedChange={(checked) => setGenerateAudio(checked === true)}
          />
          <Label htmlFor="videoAudio" className="font-normal">
            {t("dashboard:ai.generateAudio")}
          </Label>
          <input
            type="hidden"
            name="generateAudio"
            value={audio ? "true" : "false"}
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
              disabled={!options.seed}
              value={videoSeed}
              onChange={(event) => setVideoSeed(event.target.value)}
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
          {/* Left out entirely for a model that conditions on no frames: a
              picker that quietly does nothing is worse than none. */}
          {options.firstFrame && (
            <FramePicker
              id="videoFirstFrame"
              name="firstFrame"
              label={t("dashboard:ai.firstFrame")}
              hint={t("dashboard:ai.firstFrameHint")}
              file={firstFrame}
              onPick={setFirstFrame}
              clearLabel={t("dashboard:ai.clearFrame")}
            />
          )}
          {options.firstFrame && options.lastFrame && (
            <FramePicker
              id="videoLastFrame"
              name="lastFrame"
              label={t("dashboard:ai.lastFrame")}
              hint={t("dashboard:ai.lastFrameHint")}
              file={lastFrame}
              onPick={setLastFrame}
              clearLabel={t("dashboard:ai.clearFrame")}
              note={
                lastFrame && !sentLastFrame
                  ? t("dashboard:ai.lastFrameNeedsFirst")
                  : null
              }
            />
          )}
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
          // 中身を読んでいる間は送らない。読み終える前に送ると、中身の分から
          // ないまま作った名前で課金され、読み終えた時点で名前が変わる。
          disabled={submitBlocked || isPending || readingFrames}
        >
          {t("dashboard:ai.generate")}
        </SubmitButton>
      </form>
    </Card>
  );

  // Video outlives the request, so there is never an inline result to show.
  // The right column carries what the user needs to know before pressing
  // generate, and where the finished clip will turn up afterwards.
  const result = isPending ? (
    <ResultShimmer label={t("dashboard:ai.processing")} />
  ) : state.success ? (
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
