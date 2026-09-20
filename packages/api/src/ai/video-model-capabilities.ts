import {
  AI_MAX_VIDEO_INPUT_AUDIO_REFERENCES,
  AI_MAX_VIDEO_INPUT_REFERENCES,
  AI_MAX_VIDEO_INPUT_VIDEO_REFERENCES,
  AI_VIDEO_ASPECT_RATIOS,
  AI_VIDEO_DURATIONS_SECONDS,
  AI_VIDEO_RESOLUTIONS,
  MAX_AI_PROMPT_LENGTH,
  MAX_AI_SOURCE_VIDEO_UPLOAD_BYTES,
  MAX_AI_VIDEO_DURATION_SECONDS,
  MAX_AI_VIDEO_FRAME_UPLOAD_BYTES,
  MAX_AI_VIDEO_INPUT_AUDIO_BYTES,
  MAX_AI_VIDEO_INPUT_VIDEOS_TOTAL_BYTES,
  type AiVideoAspectRatio,
  type AiVideoResolution,
} from "@beutl/core";
import { listAiProviders } from "./providers/registry";
import {
  UNSTATED_VIDEO_INPUT_LIMITS,
  type AiProviderId,
  type AiVideoModelInputLimits,
  type AiVideoProvider,
} from "./providers/types";

// What a video model will actually accept, narrowed to what this service can
// ask for.
//
// The parameters a video request may carry differ per model: MiniMax H3 renders
// only at 2K and refuses anything shorter than five seconds, Veo 3.1 takes 4/6/8
// seconds at 720p or 1080p, Seedance 2.5 stops at 720p. A fixed list of options
// was right while there was one model; with several registered it produces
// requests the provider rejects, and the user is charged nothing but told only
// that "the provider failed".
//
// A field the provider publishes as null means it states no restriction, which
// is not the same as restricting to nothing — those stay unconstrained.
export type AiVideoModelCapabilities = {
  modelId: string;
  resolutions: AiVideoResolution[];
  durations: number[];
  aspectRatios: AiVideoAspectRatio[];
  generateAudio: boolean;
  seed: boolean;
  // 開始フレームと終了フレームは別の能力。片方しか取らないモデルを「フレーム
  // 対応」とひとまとめにすると、終了フレーム付きの依頼が受け付けられるように
  // 見えたまま拒否される。
  firstFrame: boolean;
  lastFrame: boolean;
  // プロンプトから動画を作れるか。Vercel AI Gateway は motion-control 専用の
  // モデルも並べており、そちらも解像度・尺・アスペクト比を普通に公開するので、
  // それだけでは「使える」と誤判定する。公開されていないときは true。
  promptToVideo: boolean;
  // 参照画像で人物や物の見た目を揃えられるか。フレーム（動画が通過する瞬間）
  // とは別の能力で、公開されていないときは「制限なし」ではなく false ——
  // 受け取れないモデルに送っても黙って無視されるだけなので、offer しない。
  referenceToVideo: boolean;
  // 手持ちの動画を材料にする 3 つのモード。既定は false で、参照画像と同じ理由
  // ——できないモデルに送っても断られるだけなので、公開されていないなら出さない。
  videoEditing: boolean;
  videoExtension: boolean;
  motionControl: boolean;
  // モデルが公開している受け入れ量を、このサービスの天井で挟んだもの。
  // 「モデルが取れるだけ取る」と「Worker が抱えられる量に収める」の両方が
  // 要る——公開値をそのまま出すと 30 枚や 200MB を offer してしまい、天井
  // だけで決めると H3 の 9 枚が 3 枚に切り詰められる。
  maxInputReferences: number;
  // 参照画像 1 枚あたり。モデルのほうが小さければそちらが勝つ。
  maxReferenceBytes: number;
  // 素材動画 1 本あたりと、その長さの範囲。範囲は公開されていなければ null。
  maxSourceVideoBytes: number;
  minSourceVideoSeconds: number | null;
  maxSourceVideoSeconds: number | null;
  // このモデルが読むプロンプトの長さ。サービスの上限より短いモデルがあり、
  // そこを見ないと「書けるのに必ず断られる」依頼が作れてしまう。
  maxPromptCharacters: number;
  // 参照として運べる動画と音声。画像とは別枠で、モデルは別々の数を公開する
  // ——H3 は画像 9 枚に対して動画 3 本。0 なら、その種類は受け取らない。
  maxVideoReferences: number;
  maxVideoReferenceBytes: number;
  maxAudioReferences: number;
  maxAudioReferenceBytes: number;
};

export type UnsupportedVideoRequestReason =
  | "resolution"
  | "duration"
  | "aspectRatio"
  | "generateAudio"
  | "seed"
  | "firstFrame"
  | "lastFrame"
  | "inputReferences"
  // 参照画像の枚数が、そのモデルの受け入れ枚数を超えている。
  | "inputReferenceCount"
  // 参照の動画・音声が、そのモデルの受け入れ数を超えている。0 のモデルに
  // 送っても警告付きで捨てられるだけなので、枚数と同じく手前で断る。
  | "videoReferenceCount"
  | "audioReferenceCount"
  // プロンプトが、そのモデルが読む長さを超えている。サービスの上限より短い
  // モデルがあるので、ここを見ないと「書けるのに必ず断られる」依頼が通る。
  | "promptLength";

const CACHE_TTL_MS = 10 * 60 * 1000;
const FAILURE_CACHE_TTL_MS = 60 * 1000;

type CacheEntry = {
  expiresAt: number;
  capabilities: Map<string, AiVideoModelCapabilities>;
};

// Per provider: each publishes its own list on its own schedule, and one
// provider's outage must not blank out another's capabilities.
const caches = new Map<AiProviderId, CacheEntry>();

export function clearAiVideoModelCapabilitiesCache(): void {
  caches.clear();
}

function intersect<T extends string | number>(
  offered: readonly T[],
  supported: readonly (string | number)[] | null | undefined,
): T[] {
  if (!supported) return [...offered];
  return offered.filter((value) => supported.includes(value));
}

// The provider reports resolutions as free-form strings ("720p", "2K"), so the
// comparison is by value rather than by a shared type.
function toCapabilities(model: {
  id: string;
  supportedResolutions: readonly string[] | null;
  supportedDurations: readonly number[] | null;
  supportedAspectRatios: readonly string[] | null;
  supportedFrameImages: readonly string[] | null;
  generateAudio: boolean | null;
  seed: boolean | null;
  supportsPromptToVideo?: boolean | null;
  supportsReferenceToVideo?: boolean | null;
  supportsVideoEditing?: boolean | null;
  supportsVideoExtension?: boolean | null;
  supportsMotionControl?: boolean | null;
  inputLimits?: AiVideoModelInputLimits;
}): AiVideoModelCapabilities {
  const limits = model.inputLimits ?? UNSTATED_VIDEO_INPUT_LIMITS;
  // 公開値とサービスの天井の、小さいほう。公開していないモデルは天井のまま
  // ——「言っていない」は「取れない」ではない。
  const boundedBy = (published: number | null, ceiling: number): number =>
    published === null ? ceiling : Math.min(published, ceiling);
  const firstFrame = !model.supportedFrameImages ||
    model.supportedFrameImages.includes("first_frame");
  return {
    modelId: model.id,
    resolutions: intersect(AI_VIDEO_RESOLUTIONS, model.supportedResolutions),
    durations: intersect(AI_VIDEO_DURATIONS_SECONDS, model.supportedDurations),
    aspectRatios: intersect(
      AI_VIDEO_ASPECT_RATIOS,
      model.supportedAspectRatios,
    ),
    generateAudio: model.generateAudio ?? true,
    seed: model.seed ?? true,
    // 何も公開していないモデルは制限なしとして扱う（null は「制限なし」であって
    // 「何も取らない」ではない）。
    firstFrame,
    // 終了フレームだけを取るモデルは、この API では動かせない。フレーム付きの
    // 経路は開始フレームを必須にしているので、開始フレームを取らないモデルは
    // 終了フレームも受け取りようがない。使えない組み合わせを公開しない。
    lastFrame: firstFrame &&
      (!model.supportedFrameImages ||
        model.supportedFrameImages.includes("last_frame")),
    promptToVideo: model.supportsPromptToVideo ?? true,
    // 既定は false。参照画像を取れるモデルはごく一部で、取れないモデルに送って
    // も警告付きで捨てられるだけ——「言っていない＝できる」にしてはならない。
    referenceToVideo: model.supportsReferenceToVideo ?? false,
    videoEditing: model.supportsVideoEditing ?? false,
    videoExtension: model.supportsVideoExtension ?? false,
    motionControl: model.supportsMotionControl ?? false,
    maxInputReferences: boundedBy(
      limits.maxImages,
      AI_MAX_VIDEO_INPUT_REFERENCES,
    ),
    maxReferenceBytes: boundedBy(
      limits.maxImageBytes,
      MAX_AI_VIDEO_FRAME_UPLOAD_BYTES,
    ),
    maxSourceVideoBytes: boundedBy(
      limits.maxVideoBytes,
      MAX_AI_SOURCE_VIDEO_UPLOAD_BYTES,
    ),
    minSourceVideoSeconds: limits.minVideoDurationSeconds,
    // モデルの上限と、このサービスが読み取れる長さの、小さいほう。
    maxSourceVideoSeconds: limits.maxVideoDurationSeconds === null
      ? null
      : Math.min(limits.maxVideoDurationSeconds, MAX_AI_VIDEO_DURATION_SECONDS),
    maxPromptCharacters: boundedBy(
      limits.maxPromptCharacters,
      MAX_AI_PROMPT_LENGTH,
    ),
    // 公開していないモデルは 0。画像と違って「言っていない＝取れる」にしては
    // ならない——取れないモデルに送っても警告付きで捨てられるだけで、課金だけ
    // が残る。
    maxVideoReferences: limits.maxVideos === null
      ? 0
      : Math.min(limits.maxVideos, AI_MAX_VIDEO_INPUT_VIDEO_REFERENCES),
    // 本数が 0 なら大きさも 0。「1 本あたり 32MiB まで、ただし 0 本」は読み手を
    // 迷わせるだけで、どちらか一方を見た画面が欄を出してしまう。
    maxVideoReferenceBytes: limits.maxVideos === null
      ? 0
      : boundedBy(limits.maxVideoBytes, MAX_AI_VIDEO_INPUT_VIDEOS_TOTAL_BYTES),
    // 常に 0。メタデータは 13 モデルが音声を受けると言っており、
    // inputReferences に載せれば Gateway は警告なしで受理もするが、実地で
    // 確かめたところ**消費されている証拠が無い**（2026-09-20、alibaba/
    // wan-v2.6-t2v 1280x720 2s で検証）：
    //
    //   無音の WAV を付けて送る            -> completed / 警告なし
    //   audio/wav を名乗る壊れたバイト列   -> completed / 警告なし
    //
    // 読まれていれば後者は落ちる。落ちない以上、参照は素通しされているだけで、
    // 欄を出せば「押しても何も起きない操作」を売ることになる——このコードベース
    // が参照画像について何度も避けてきたのと同じ失敗。
    //
    // 読み取りと上限の計算はそのまま残してある。プロバイダが実際に使うように
    // なったら、この 2 行を boundedBy 版に戻すだけで開く。
    maxAudioReferences: 0,
    maxAudioReferenceBytes: 0,
  };
}

// One request covers every model, so the whole list is cached rather than each
// model separately.
//
// A failed lookup caches an empty map for a shorter while: callers treat an
// absent entry as "no restriction known", so an outage at the provider leaves
// video generation working exactly as it did before capabilities were consulted
// rather than taking it offline.
async function loadForProvider(
  providerId: AiProviderId,
  video: AiVideoProvider,
  now: number,
): Promise<Map<string, AiVideoModelCapabilities>> {
  const cached = caches.get(providerId);
  if (cached && cached.expiresAt > now) return cached.capabilities;
  let capabilities: Map<string, AiVideoModelCapabilities>;
  let ttl = CACHE_TTL_MS;
  try {
    const models = await video.listModels();
    capabilities = new Map(
      models.map((model) => [model.id, toCapabilities(model)]),
    );
  } catch (error) {
    // This lookup deliberately fails open, so report a degraded optional read
    // as a warning rather than turning a successfully rendered page into an
    // error event. Keep only the normalized message instead of serializing an
    // SDK error and its worker stack as the log message.
    console.warn(`Failed to read ${providerId} video model capabilities`, {
      message: error instanceof Error ? error.message : String(error),
    });
    capabilities = new Map();
    ttl = FAILURE_CACHE_TTL_MS;
  }
  caches.set(providerId, { expiresAt: now + ttl, capabilities });
  return capabilities;
}

export async function loadAiVideoModelCapabilities(
  now = Date.now(),
): Promise<Map<string, AiVideoModelCapabilities>> {
  const perProvider = await Promise.all(
    listAiProviders().flatMap((provider) =>
      provider.video ? [loadForProvider(provider.id, provider.video, now)] : [],
    ),
  );
  // One provider is the common case; hand its map back rather than copying it.
  // Model ids stay unambiguous across providers because the catalog registers
  // any one id for an operation exactly once.
  if (perProvider.length === 1) return perProvider[0];
  const merged = new Map<string, AiVideoModelCapabilities>();
  for (const capabilities of perProvider) {
    for (const [modelId, entry] of capabilities) merged.set(modelId, entry);
  }
  return merged;
}

// Why the provider would refuse this request, or null if nothing rules it out.
//
// An unknown model yields null: the catalog decides which models exist, and
// refusing one merely missing from the provider's list would take a working
// model offline on a stale response.
export function unsupportedVideoRequestReason(
  capabilities: AiVideoModelCapabilities | undefined,
  request: {
    resolution: string;
    durationSeconds: number;
    aspectRatio?: string;
    generateAudio?: boolean;
    seed?: number;
    firstFrame?: boolean;
    lastFrame?: boolean;
    /** How many reference pictures the request carries, not merely whether it does. */
    inputReferences?: number;
    /** Reference clips and sounds, counted separately: a model allows each its own number. */
    videoReferences?: number;
    audioReferences?: number;
    promptCharacters?: number;
  },
): UnsupportedVideoRequestReason | null {
  if (!capabilities) return null;
  if (!capabilities.resolutions.includes(request.resolution as AiVideoResolution)) {
    return "resolution";
  }
  if (!capabilities.durations.includes(request.durationSeconds)) {
    return "duration";
  }
  if (
    request.aspectRatio !== undefined &&
    !capabilities.aspectRatios.includes(request.aspectRatio as AiVideoAspectRatio)
  ) {
    return "aspectRatio";
  }
  // Asking for audio from a model that cannot produce it is a refusal; asking
  // it not to is always fine.
  if (request.generateAudio === true && !capabilities.generateAudio) {
    return "generateAudio";
  }
  if (request.seed !== undefined && !capabilities.seed) {
    return "seed";
  }
  if (request.firstFrame === true && !capabilities.firstFrame) {
    return "firstFrame";
  }
  if (request.lastFrame === true && !capabilities.lastFrame) {
    return "lastFrame";
  }
  if (
    ((request.inputReferences ?? 0) > 0 ||
      (request.videoReferences ?? 0) > 0 ||
      (request.audioReferences ?? 0) > 0) &&
    !capabilities.referenceToVideo
  ) {
    return "inputReferences";
  }
  if ((request.inputReferences ?? 0) > capabilities.maxInputReferences) {
    return "inputReferenceCount";
  }
  if ((request.videoReferences ?? 0) > capabilities.maxVideoReferences) {
    return "videoReferenceCount";
  }
  if ((request.audioReferences ?? 0) > capabilities.maxAudioReferences) {
    return "audioReferenceCount";
  }
  if (
    request.promptCharacters !== undefined &&
    request.promptCharacters > capabilities.maxPromptCharacters
  ) {
    return "promptLength";
  }
  return null;
}

// Whether the model can serve any request at all. A model that shares no
// resolution, duration or aspect ratio with this service — or that does not
// generate from a prompt in the first place — is registered but unusable, and
// offering it would only ever produce a refused request.
/**
 * Of the models registered for an operation, the ones that cannot serve a
 * single request it can build.
 *
 * Takes the operation because what makes a model usable is not a property of
 * the model alone. A motion-control model publishes no text-to-video and is
 * useless for a generation, which is exactly the model video.motion runs on;
 * asking the generation question about every registered row condemned the only
 * model that operation has.
 *
 * A model the provider says nothing about is left alone, the same way
 * isVideoModelUsable does: a stale list must not take a working model offline.
 */
export function unusableVideoModelsFor(
  operation: string,
  modelIds: readonly string[],
  capabilities: ReadonlyMap<string, AiVideoModelCapabilities>,
): Set<string> {
  return new Set(
    modelIds.filter(
      (modelId) => !isVideoModelUsable(capabilities.get(modelId), operation),
    ),
  );
}

export function isVideoModelUsable(
  capabilities: AiVideoModelCapabilities | undefined,
  operation = "video.generate",
): boolean {
  if (!capabilities) return true;
  // 手持ちの動画を材料にするモードは、その 1 つの能力がすべて。尺や解像度は
  // 素材の側が決めるか、そもそも受け付けられない。
  if (operation === "video.edit") return capabilities.videoEditing;
  if (operation === "video.extend") return capabilities.videoExtension;
  if (operation === "video.motion") return capabilities.motionControl;
  return (
    // 動画を作る以外の仕事のためのモデルは、ほかが何を公開していても使えない。
    capabilities.promptToVideo !== false &&
    capabilities.resolutions.length > 0 &&
    capabilities.durations.length > 0 &&
    capabilities.aspectRatios.length > 0
  );
}
