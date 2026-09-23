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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@beutl/ui/ui/select";
import { Slider } from "@beutl/ui/ui/slider";
import { Clapperboard, Clock, Coins, History, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  AI_MAX_SEED,
  AI_MAX_VIDEO_INPUT_REFERENCES,
  AI_MIN_SEED,
  AI_VIDEO_ASPECT_RATIOS,
  AI_VIDEO_DURATIONS_SECONDS,
  AI_VIDEO_RESOLUTIONS,
  MAX_AI_SOURCE_VIDEO_UPLOAD_BYTES,
  MAX_AI_VIDEO_FRAME_UPLOAD_BYTES,
  MAX_AI_PROMPT_LENGTH,
  formatBytes,
} from "@beutl/core";
import { composePrompt } from "@/lib/ai-prompt";
import { runAiRequest } from "@/lib/ai-request";
import { buildAiVideoSubmission, selectVideoReferences, videoReferenceFingerprintLimit } from "@/lib/ai-video-submit";
import { PromptLibrary, type PromptTemplate } from "./prompt-library";
import {
  AdvancedOptions,
  AiAccessNotice,
  ModelSelect,
  AiWorkspace,
  ResultPanel,
  ResultShimmer,
  blockedReason,
  blocksSubmit,
  canSubmitModelRequest,
  canSubmitAiRequest,
  correctedModelId,
  requestSignature,
  seedValue,
  useFileFingerprints,
  useVideoInputDurations,
  VideoInputDurationNotice,
  useAiRequestNames,
  useHeldModelCapabilities,
  defaultModelId,
  isAiPromptWithinLimit,
  keepsIdempotencyKey,
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
        <img src={preview} alt={label} className="mt-1 max-w-[12rem] rounded-lg border" />
      )}
    </div>
  );
}

function Note({ icon: Icon, children }: { icon: typeof Clock; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="text-sm text-muted-foreground">{children}</span>
    </li>
  );
}

// What each registered model will accept, read from the provider. A model
// missing from this map states no restriction and keeps every option.
/**
 * One kind of reference, in a field of its own.
 *
 * Separate fields rather than one that takes everything: a model allows each
 * kind its own number, so "3 / 9" means nothing until it says which three, and
 * a picker that takes anything invites a file the chosen model has no
 * allowance for at all.
 */
function ReferencePicker({
  id,
  label,
  hint,
  accept,
  multiple,
  files,
  removeLabel,
  problem,
  onPick,
}: {
  id: string;
  label: string;
  hint: string;
  accept: string;
  multiple: boolean;
  files: File[];
  removeLabel: (name: string) => string;
  // Why this selection cannot be sent, or null. Said rather than silently
  // trimmed: what is on screen has to be what is bought.
  problem: string | null;
  onPick: (files: File[]) => void;
}) {
  // 欄はブラウザのもので、こちらからは空にできない。選び直しの結果を書き戻す
  // のが、持っているものと見えているものを揃える唯一の方法。
  const input = useRef<HTMLInputElement>(null);
  function apply(next: File[]) {
    onPick(next);
    const selection = new DataTransfer();
    for (const file of next) selection.items.add(file);
    if (input.current) input.current.files = selection.files;
  }

  return (
    <div className="flex flex-col space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        ref={input}
        id={id}
        type="file"
        multiple={multiple}
        accept={accept}
        onChange={(event) => {
          const picked = [...(event.target.files ?? [])];
          const added = picked.filter(
            (file) =>
              !files.some(
                (existing) =>
                  existing.name === file.name && existing.size === file.size,
              ),
          );
          apply([...files, ...added]);
        }}
      />
      {files.length > 0 && (
        <ul className="flex flex-col gap-1">
          {files.map((file) => (
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
                aria-label={removeLabel(file.name)}
                onClick={() => apply(files.filter((entry) => entry !== file))}
              >
                <X className="h-3 w-3" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p
        className={
          problem ? "text-xs text-destructive" : "text-xs text-muted-foreground"
        }
      >
        {problem ?? hint}
      </p>
    </div>
  );
}

export type AiVideoModelOptions = {
  resolutions: string[];
  durations: number[];
  aspectRatios: string[];
  generateAudio: boolean;
  audioRequired?: boolean;
  seed: boolean;
  firstFrame: boolean;
  lastFrame: boolean;
  // Pictures the video keeps faithful to rather than passes through. Unlike
  // the rest, an unstated value means "no": a model handed references it
  // cannot use ignores them and warns, and a control that quietly does nothing
  // is worse than one that is not there.
  referenceToVideo: boolean;
  // このモデルが実際に受け取る量。一律の数字で切ると、9 枚取れるモデルに
  // 3 枚しか渡せない。
  maxInputReferences: number;
  maxReferenceBytes: number;
  maxSourceVideoBytes: number;
  minSourceVideoSeconds: number | null;
  maxSourceVideoSeconds: number | null;
  maxPromptCharacters: number;
  // 参照として運べる動画と音声。画像とは別枠で、0 ならその種類は出さない。
  maxVideoReferences: number;
  maxVideoReferenceBytes: number;
  maxAudioReferences: number;
  maxAudioReferenceBytes: number;
  // 種類ごとに収まっていても、合計でこれを超えると送れない。null は「合計の
  // 制限は無い」。
  maxTotalReferences: number | null;
};

type VideoSubmitState = {
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
    (record.status === "running" || record.status === "succeeded" || record.status === "failed")
  );
}

// The options this screen offers, narrowed to one model. Values are derived on
// every render rather than corrected in state: switching to a model that cannot
// do 1080p must not leave a stale 1080p in a hidden field, which is what the
// server would then be charged for and refuse.
function optionsOf(capabilities: Record<string, AiVideoModelOptions> | undefined, modelId: string) {
  const supported = capabilities?.[modelId];
  return {
    durations: supported?.durations.length ? supported.durations : [...AI_VIDEO_DURATIONS_SECONDS],
    resolutions: supported?.resolutions.length ? supported.resolutions : [...AI_VIDEO_RESOLUTIONS],
    aspectRatios: supported?.aspectRatios.length
      ? supported.aspectRatios
      : [...AI_VIDEO_ASPECT_RATIOS],
    generateAudio: supported?.generateAudio ?? true,
    audioRequired: supported?.audioRequired ?? false,
    seed: supported?.seed ?? true,
    firstFrame: supported?.firstFrame ?? true,
    lastFrame: supported?.lastFrame ?? true,
    referenceToVideo: supported?.referenceToVideo ?? false,
    maxInputReferences: supported?.maxInputReferences
      ?? AI_MAX_VIDEO_INPUT_REFERENCES,
    maxReferenceBytes: supported?.maxReferenceBytes
      ?? MAX_AI_VIDEO_FRAME_UPLOAD_BYTES,
    maxSourceVideoBytes: supported?.maxSourceVideoBytes
      ?? MAX_AI_SOURCE_VIDEO_UPLOAD_BYTES,
    minSourceVideoSeconds: supported?.minSourceVideoSeconds ?? null,
    maxSourceVideoSeconds: supported?.maxSourceVideoSeconds ?? null,
    maxPromptCharacters: supported?.maxPromptCharacters ?? MAX_AI_PROMPT_LENGTH,
    maxVideoReferences: supported?.maxVideoReferences ?? 0,
    maxVideoReferenceBytes: supported?.maxVideoReferenceBytes ?? 0,
    maxAudioReferences: supported?.maxAudioReferences ?? 0,
    maxAudioReferenceBytes: supported?.maxAudioReferenceBytes ?? 0,
    maxTotalReferences: supported?.maxTotalReferences ?? null,
  };
}

// 欄ごとに受け取る型。サーバーが読める種類だけを並べる——読めないものを
// 選ばせると、アップロードが終わってから断られる。
const REFERENCE_ACCEPT = {
  image: "image/png,image/jpeg,image/webp",
  video: "video/mp4,video/webm",
  audio: "audio/wav,audio/mpeg",
} as const;

/** 参照 1 つの種類。サーバーと同じ見分け方をする。 */
function referenceKindOf(mediaType: string): "image" | "video" | "audio" | null {
  const type = mediaType.split(";", 1)[0]!.trim().toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type === "video/mp4" || type === "video/webm") return "video";
  if (["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3"].includes(type)) {
    return "audio";
  }
  return null;
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
  userId,
  access,
  capabilities,
}: {
  lang: string;
  userId: string;
  access: AiAccess;
  capabilities?: Record<string, AiVideoModelOptions>;
}) {
  const { t } = useTranslation(lang);
  const [state, setState] = useState<VideoSubmitState>({
    success: false,
  });
  const [isPending, setIsPending] = useState(false);
  // Acquiring the durable request name is asynchronous. React's pending state
  // cannot close the double-click window before that await, so guard it
  // synchronously as well.
  const submittingRef = useRef(false);
  const activeRequestRef = useRef<AbortController | null>(null);
  const [videoDuration, setVideoDuration] = useState<string>("4");
  const [videoResolution, setVideoResolution] = useState<string>("720p");
  const [videoAspectRatio, setVideoAspectRatio] = useState<string>("16:9");
  const [generateAudio, setGenerateAudio] = useState(true);
  const [videoPrompt, setVideoPrompt] = useState("");
  const [videoStyle, setVideoStyle] = useState("");
  const names = useAiRequestNames(userId, "video.generate");
  const [model, setModel] = useState(() => defaultModelId(access.models["video.generate"] ?? []));
  const [videoComposition, setVideoComposition] = useState("");
  const [videoMotion, setVideoMotion] = useState("");
  const [videoExclusions, setVideoExclusions] = useState("");
  const [videoSeed, setVideoSeed] = useState("");
  const [firstFrame, setFirstFrame] = useState<File | null>(null);
  const [lastFrame, setLastFrame] = useState<File | null>(null);
  // 種類ごとに別々に持つ。モデルは画像・動画・音声に別々の数を公開するので、
  // 1 本の配列に混ぜると、どれがどの枠を使っているのか画面から分からない。
  const [imageReferences, setImageReferences] = useState<File[]>([]);
  const [videoReferences, setVideoReferences] = useState<File[]>([]);
  const [audioReferences, setAudioReferences] = useState<File[]>([]);

  // A Server Action keeps running after its browser has reloaded because it has
  // no Request signal. This screen submits through the internal route instead;
  // aborting its fetch on navigation lets that route pass cancellation all the
  // way to the provider while the durable idempotency key stays recoverable.
  useEffect(() => {
    return () => activeRequestRef.current?.abort();
  }, []);

  const models = useMemo(() => access.models["video.generate"] ?? [], [access.models]);
  const selectableModels = names.modelsWithHeld(models);
  const blocked = blockedReason(access, ["video.generate"], models.length === 0);
  // 直前の失敗が名前を残していれば、残高で塞がない。支払い済みの結果を取りに
  // 行く道を閉じることになる。
  const keepsName = (state as { keepIdempotencyKey?: boolean }).keepIdempotencyKey === true;
  useEffect(() => {
    names.settle(keepsName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  const heldCapabilities = useHeldModelCapabilities(
    capabilities,
    names.heldRequestModels(),
    models.map((entry) => entry.id),
    names.heldRequestCapabilities(),
  );
  const options = optionsOf(heldCapabilities, model);
  const duration = nearestDuration(Number(videoDuration), options.durations);
  const resolution = firstSupported(videoResolution, options.resolutions);
  const aspectRatio = firstSupported(videoAspectRatio, options.aspectRatios);
  // A model that cannot produce sound would refuse the request outright.
  const audio = options.audioRequired || (options.generateAudio && generateAudio);
  // 選ばれた時に一度だけ読む。名前と大きさだけでは、中身の違う同名同サイズの絵が
  // 同じ依頼に見え、片方が走っている間もう片方を始められない。
  // モデルが受け取るものだけを読む。非対応モデルへ切り替えたときに、画面から
  // 隠れた選択中のファイルを依頼の一部として扱わない。
  const sentFirstFrame = options.firstFrame ? firstFrame : null;
  const sentLastFrame = sentFirstFrame && options.lastFrame ? lastFrame : null;
  // 参照はフレームの代わりであって、足し算ではない。両方を受け取ったプロバイダ
  // は参照を黙って捨てて警告するだけなので、API は組み合わせそのものを断る。
  // ここでも同じ扱いにする——送らないものを数えれば、画面に見えている条件と、
  // その名前で買うものが食い違う。
  // 種類ごとの枠。モデルは画像・動画・音声に別々の数を公開するので、1 つの
  // 数で切ると必ずどれかを取りこぼす——H3 は画像 9 枚に動画 3 本。
  const referenceKinds = useMemo(
    () =>
      [
        {
          kind: "image" as const,
          files: imageReferences,
          maxCount: options.maxInputReferences,
          maxBytes: options.maxReferenceBytes,
        },
        {
          kind: "video" as const,
          files: videoReferences,
          maxCount: options.maxVideoReferences,
          maxBytes: options.maxVideoReferenceBytes,
        },
        {
          kind: "audio" as const,
          files: audioReferences,
          maxCount: options.maxAudioReferences,
          maxBytes: options.maxAudioReferenceBytes,
        },
      ].map((entry) => ({
        ...entry,
        tooMany: entry.files.length > entry.maxCount,
        oversized: entry.files.some((file) => file.size > entry.maxBytes),
      })),
    [
      imageReferences,
      videoReferences,
      audioReferences,
      options.maxInputReferences,
      options.maxReferenceBytes,
      options.maxVideoReferences,
      options.maxVideoReferenceBytes,
      options.maxAudioReferences,
      options.maxAudioReferenceBytes,
    ],
  );
  // 送るのは、画像・動画・音声の順。並びは依頼の一部で、文章が「1 枚目」と
  // 言う相手が変わる。
  const sendsReferences = options.referenceToVideo && sentFirstFrame === null;
  const referenceSelection = useMemo(
    () => selectVideoReferences({
      enabled: sendsReferences,
      kinds: referenceKinds,
      maxTotalReferences: options.maxTotalReferences,
    }),
    [sendsReferences, referenceKinds, options.maxTotalReferences],
  );
  const sentReferences = referenceSelection.files;
  const oversizedReference = referenceSelection.oversized;
  const tooManyInTotal = referenceSelection.tooManyInTotal;
  const tooManyReferences = referenceSelection.tooMany;
  const videoReferencesToInspect = useMemo(
    () => oversizedReference || tooManyReferences
      ? []
      : sentReferences.filter((file) => referenceKindOf(file.type) === "video"),
    [oversizedReference, tooManyReferences, sentReferences],
  );
  const referenceDurations = useVideoInputDurations(
    videoReferencesToInspect,
    options.minSourceVideoSeconds,
    options.maxSourceVideoSeconds,
  );
  const invalidReferenceDuration = referenceDurations.error !== null;
  const waitForReferenceDurations = referenceDurations.reading || invalidReferenceDuration;
  const frames = useMemo(
    () => [sentFirstFrame, sentLastFrame].filter((frame): frame is File => frame !== null),
    [sentFirstFrame, sentLastFrame],
  );
  const frameByteLimit = Math.min(options.maxReferenceBytes, MAX_AI_VIDEO_FRAME_UPLOAD_BYTES);
  const { contents: frameContents, reading: readingFrames } = useFileFingerprints(
    frames,
    frameByteLimit,
  );
  // 送れないと分かっているものは読まない——名前には要らない。ここで毎回
  // 新しい配列を作ってはいけない：useFileFingerprints は配列の同一性を
  // effect の依存に持ち、その effect が state を書くので、描画が止まらなく
  // なる。フレーム側が useMemo を通しているのと同じ理由。
  const fingerprintedReferences = useMemo(
    () => (oversizedReference || tooManyReferences || waitForReferenceDurations ? [] : sentReferences),
    [oversizedReference, tooManyReferences, waitForReferenceDurations, sentReferences],
  );
  const { contents: referenceContents, reading: readingReferenceFiles } =
    useFileFingerprints(fingerprintedReferences, videoReferenceFingerprintLimit);
  const readingReferences = readingReferenceFiles || referenceDurations.reading;
  const oversizedFrame =
    [sentFirstFrame, sentLastFrame].some(
      (frame) => frame !== null && frame.size > frameByteLimit,
    ) || oversizedReference || tooManyReferences;
  // 実際に送るフレーム。モデルが取らないものは送らず、終わりのフレームは始まり
  // があるときだけ送る——この API に始まりの無い依頼は無い。名前もここから
  // 作るので、画面に見えている条件と、その名前で買うものが食い違わない。
  const firstFrameContent = sentFirstFrame ? (frameContents[0] ?? "") : "";
  const lastFrameContent = sentLastFrame ? (frameContents[sentFirstFrame ? 1 : 0] ?? "") : "";
  // サーバーが指紋を取るのと同じものから、こちらで見えるぶんだけ。文章はここに
  // ある材料から組み立てられるので、材料をそのまま数える。種とフレームは入力欄
  // の中にあって描画のたびには読めない——そのぶんこの署名は粗く、粗いほうへ
  // 外れるのは安全側だ。同じ名前で別の依頼が届けば断られるだけで、同じ依頼が
  // 二つの名前に割れて二度課金されることはない。
  const signature = oversizedFrame || invalidReferenceDuration ? "" : requestSignature([
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
    // 参照も同じ扱い。並びは依頼の一部——文章が「1 枚目」と言う相手が変わる。
    sentReferences.length,
    referenceContents.join("\u001f"),
  ]);
  useEffect(() => {
    if (names.ready && !readingFrames && !readingReferences && !oversizedFrame && !invalidReferenceDuration)
      void names.ensure(signature);
  }, [names.ready, names, readingFrames, readingReferences, signature, oversizedFrame, invalidReferenceDuration]);
  // いま画面にある依頼の名前を持っているか。直前の応答が決着していても、
  // 別の依頼の名前はまだ手元にある——そちらへ戻ったときに残高で塞ぐと、
  // 支払い済みの結果を取りに行く道が閉じる。
  const holdsName = !oversizedFrame && !invalidReferenceDuration && names.holds(signature);
  const holdsSelectedModel = names.holdsModel(model) || names.hasRestoredModel(model);
  useEffect(() => {
    if (readingFrames) return;
    if (names.hasRestoredModel("") && !names.holdsModel("") && model !== "") {
      setModel("");
      return;
    }
    const corrected = correctedModelId(models, model, holdsSelectedModel);
    if (corrected !== model) setModel(corrected);
  }, [holdsSelectedModel, model, models, names, readingFrames]);
  const modelCanSubmit = canSubmitModelRequest(models, model, holdsSelectedModel, holdsName);
  const submitBlocked = blocksSubmit(blocked, holdsName) || oversizedFrame || invalidReferenceDuration || !modelCanSubmit;
  const canSubmit = canSubmitAiRequest({
    submitBlocked,
    hasTask: true,
    taskUnaffordable: false,
    taskHasNoModel: models.length === 0 && !holdsName,
    // 中身を読んでいる間は送らない。読み終える前に送ると、中身の分からないまま
    // 作った名前で課金され、読み終えた時点で名前が変わってしまう。
    busy: isPending || readingFrames || readingReferences || oversizedFrame,
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
  // このモデルが読む長さ。サービスの上限より短いモデルがあり、そこを見ないと
  // 「書けるのに必ず断られる」依頼が作れる。
  const promptLimit = options.maxPromptCharacters;
  const composedPromptTooLong =
    !isAiPromptWithinLimit(composedLength) || composedLength > promptLimit;

  // 送るものを、名乗ったものに合わせる。フレームの入力欄はモデルの都合で画面
  // から外れ、外れた時点で選ばれていたファイルは欄ごと消える——画面の状態だけ
  // が残り、名前は「フレームあり」と言いながらフレームの無い本文が出ていく。
  // 欄ではなく画面の状態から組み立てれば、その食い違いは起きない。
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // ボタンとキーボード送信で同じ答えを使う。片方だけを見ていると、入力欄で
    // Enter を押したときにボタンが断っているはずの依頼が出ていく。
    if (
      !canSubmit ||
      composedPromptTooLong ||
      oversizedFrame ||
      readingFrames ||
      readingReferences ||
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
        names.heldCapabilityFor(signature) ?? heldCapabilities[model] ?? null,
      );
      if (!idempotencyKey) return;

      const composedPrompt = composePrompt({
        main: videoPrompt,
        style: videoStyle,
        composition: videoComposition,
        motion: videoMotion,
        exclusions: videoExclusions,
      });
      const { operation, body } = buildAiVideoSubmission({
        prompt: composedPrompt,
        durationSeconds: duration,
        resolution,
        aspectRatio,
        generateAudio: audio,
        model,
        seedEnabled: options.seed,
        seedText: videoSeed,
        firstFrame: sentFirstFrame,
        lastFrame: sentLastFrame,
        references: sentReferences,
      });

      const outcome = await runAiRequest<VideoJobResponse>(operation, {
        body,
        idempotencyKey,
        signal: controller.signal,
      });
      if (!outcome.ok) {
        setState({
          success: false,
          message: t(`api-errors:${outcome.errorCode}`),
          ...(keepsIdempotencyKey(outcome.errorCode) ? { keepIdempotencyKey: true } : {}),
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
        setState({
          success: false,
          message: t("api-errors:aiProviderError"),
        });
        return;
      }
      setState({ success: true, jobId: outcome.result.jobId });
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error("AI video submission response was lost", error);
        setState({
          success: false,
          message: t("api-errors:aiRequestInterrupted"),
          keepIdempotencyKey: true,
        });
      }
    } finally {
      if (activeRequestRef.current === controller) {
        activeRequestRef.current = null;
      }
      submittingRef.current = false;
      if (!controller.signal.aborted) setIsPending(false);
    }
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
      <form method="post" onSubmit={handleSubmit} className="flex flex-col gap-4 p-6">
        <PromptLibrary
          lang={lang}
          userId={userId}
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
                composedPromptTooLong ? "text-destructive" : "text-muted-foreground"
              }`}
            >
              {composedLength} / {promptLimit}
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

        <ModelSelect lang={lang} models={selectableModels} value={model} onChange={setModel} />

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
            <Label htmlFor="videoResolution">{t("dashboard:ai.resolution")}</Label>
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
            <Label htmlFor="videoAspectRatio">{t("dashboard:ai.aspectRatio")}</Label>
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
            disabled={!options.generateAudio || options.audioRequired}
            onCheckedChange={(checked) => setGenerateAudio(checked === true)}
          />
          <Label htmlFor="videoAudio" className="font-normal">
            {t("dashboard:ai.generateAudio")}
          </Label>
          <input type="hidden" name="generateAudio" value={audio ? "true" : "false"} />
        </div>

        {options.audioRequired && (
          <p className="text-xs text-muted-foreground">
            {t("dashboard:ai.audioRequired")}
          </p>
        )}

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
            <p className="text-xs text-muted-foreground">{t("dashboard:ai.seedHint")}</p>
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
            <Label htmlFor="videoComposition">{t("dashboard:ai.promptComposition")}</Label>
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
            <Label htmlFor="videoExclusions">{t("dashboard:ai.promptAvoid")}</Label>
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
              note={firstFrame && firstFrame.size > frameByteLimit
                ? t("dashboard:ai.referenceImageTooLarge", { maximum: formatBytes(frameByteLimit) })
                : null}
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
              note={lastFrame && !sentLastFrame
                ? t("dashboard:ai.lastFrameNeedsFirst")
                : lastFrame && lastFrame.size > frameByteLimit
                  ? t("dashboard:ai.referenceImageTooLarge", { maximum: formatBytes(frameByteLimit) })
                  : null}
            />
          )}
          {/* Only for a model that says it conditions on references. Unstated
              means no here: a model handed pictures it cannot use drops them
              with a warning, and paying for a request whose references were
              ignored is worse than not being offered them.

              One field per kind, because a model allows each its own number —
              "3 / 9" means nothing until it says which three. A kind the model
              takes none of is left out entirely. */}
          {options.referenceToVideo && (
            <>
              {referenceKinds.map((entry) => {
                if (entry.maxCount <= 0) return null;
                const setter =
                  entry.kind === "image"
                    ? setImageReferences
                    : entry.kind === "video"
                      ? setVideoReferences
                      : setAudioReferences;
                return (
                  <ReferencePicker
                    key={entry.kind}
                    id={`videoReference-${entry.kind}`}
                    label={t(`dashboard:ai.videoReferences.${entry.kind}`)}
                    hint={t(`dashboard:ai.videoReferenceHints.${entry.kind}`, {
                      maximum: entry.maxCount,
                      size: formatBytes(entry.maxBytes),
                    })}
                    accept={REFERENCE_ACCEPT[entry.kind]}
                    multiple={entry.maxCount > 1}
                    files={entry.files}
                    removeLabel={(name) =>
                      t("dashboard:ai.referenceImageRemove", { name })
                    }
                    problem={
                      entry.tooMany
                        ? t("dashboard:ai.referenceImageTooMany", {
                            maximum: entry.maxCount,
                          })
                        : entry.oversized
                          ? t("dashboard:ai.referenceImageTooLarge", {
                              maximum: formatBytes(entry.maxBytes),
                            })
                          : null
                    }
                    onPick={setter}
                  />
                );
              })}
              <VideoInputDurationNotice lang={lang} status={referenceDurations} />
              {/* Each field is within its own limit, so nothing above says
                  why the button is off. The aggregate has to speak for
                  itself. */}
              {tooManyInTotal && (
                <p className="text-xs text-destructive">
                  {t("dashboard:ai.referenceTooManyInTotal", {
                    maximum: options.maxTotalReferences,
                  })}
                </p>
              )}
              {/* Said rather than silently dropped: the selection is still
                  here if the frame is cleared, but it is not what is being
                  bought while a frame is chosen. */}
              {referenceKinds.some((entry) => entry.files.length > 0) &&
                sentFirstFrame !== null && (
                  <p className="text-xs text-destructive">
                    {t("dashboard:ai.videoReferenceExcludesFrames")}
                  </p>
                )}
            </>
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
          disabled={
            !names.ready ||
            submitBlocked ||
            composedPromptTooLong || oversizedFrame ||
            isPending ||
            readingFrames ||
            readingReferences
          }
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
      <p className="text-sm text-muted-foreground">{t("dashboard:ai.videoQueued")}</p>
      <Button asChild variant="outline" size="sm" className="self-start">
        <Link href={`/${lang}/dashboard/ai/jobs`} prefetch={false}>
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
