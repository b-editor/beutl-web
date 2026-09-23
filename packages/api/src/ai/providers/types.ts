// What an AI provider has to be able to do, expressed without naming one.
//
// The payload types here are the ones that cross the provider boundary in both
// directions. They were OpenRouter's types because OpenRouter was the only
// provider; ./openrouter re-exports them under its old names so nothing that
// imports from there has to change.
//
// A provider implements only the operations it can actually serve. That is not
// a convenience — providers do not necessarily expose every operation. An
// interface that forced them to declare unsupported operations would turn
// "this provider cannot do that" into a runtime failure the user pays for.
// `supports` is how the catalog refuses to register a model for an operation
// its provider cannot run; per-model capabilities narrow that answer further.

import type {
  AiImageAspectRatio,
  AiImageBackground,
  AiVideoAspectRatio,
  AiVideoResolution,
} from "@beutl/core";
import type { TranscriptionResult } from "../audio-validation";
import type { ProviderCostUsd } from "../provider-cost";
import type {
  GeneratedVideoExtension,
  GeneratedVideoMimeType,
} from "../video-validation";
import type { AiExecutionOutcome } from "./errors";

export type AiProviderId = "openrouter" | "vercel-gateway";

/**
 * The operations that work from a video this service already holds.
 *
 * They are grouped because what separates them from ordinary generation is the
 * same thing in each case: the request names a finished job of the user's own
 * and the provider is handed its result, rather than the caller uploading
 * anything. Only a provider with a field for a source video can serve them.
 */
export const AI_SOURCE_VIDEO_OPERATIONS: ReadonlySet<string> = new Set([
  "video.edit",
  "video.extend",
  "video.motion",
]);

export const AI_PROVIDER_IDS: readonly AiProviderId[] = [
  "openrouter",
  "vercel-gateway",
];

export function isAiProviderId(value: unknown): value is AiProviderId {
  return (
    typeof value === "string" &&
    (AI_PROVIDER_IDS as readonly string[]).includes(value)
  );
}

/* ------------------------------------------------------------------ video */

export type AiVideoJobStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export type VideoFrameImage = {
  type: "image_url";
  image_url: { url: string };
  frame_type: "first_frame" | "last_frame";
};

/**
 * A picture the model should keep a character or object consistent with, for
 * reference-to-video.
 *
 * Not a frame: a frame is a moment the video passes through, a reference is a
 * likeness the video should contain. Providers differ over how the bytes may
 * arrive — Veo reads only inline data and ignores a URL with a warning, Wan
 * reads only a URL — so both forms are carried and the adapter picks.
 */
export type VideoInputReference = {
  type: "image_url";
  image_url: { url: string };
  // Carried separately because a hosted URL does not announce it, and at least
  // one provider treats an untyped reference as an image and warns.
  media_type: string;
};

export type AiVideoJobInfo = {
  id: string;
  status: AiVideoJobStatus;
  error?: string | null;
  /** Actual provider charge in USD, available on a terminal response. */
  providerCostUsd?: ProviderCostUsd;
  /**
   * Whatever the provider needs to hand the finished bytes over, opaque to
   * everything but the provider that produced it. OpenRouter downloads by job
   * id and leaves this unset; the Gateway answers a status request with the
   * bytes or a hosted URL and puts them here, because there is no second call
   * that would fetch them by id.
   */
  result?: unknown;
};

export type AiVideoContent = {
  bytes: ArrayBuffer;
  mimeType: GeneratedVideoMimeType;
  extension: GeneratedVideoExtension;
};

/**
 * Which shape of video request this is.
 *
 * Absent for an ordinary generation. The rest work from a video this service
 * already holds, handed to the provider as a URL rather than uploaded by the
 * caller.
 */
export type AiVideoMode = "edit" | "extend" | "motion";

export type AiVideoStartRequest = {
  prompt: string;
  durationSeconds: number;
  resolution: AiVideoResolution;
  aspectRatio?: AiVideoAspectRatio;
  generateAudio?: boolean;
  seed?: number;
  frameImages?: VideoFrameImage[];
  /**
   * Reference pictures for reference-to-video. Never sent together with
   * `frameImages`: a provider given both ignores these and warns, so the entry
   * point refuses the combination instead of quietly dropping half the request.
   */
  inputReferences?: VideoInputReference[];
  /** Absent for an ordinary generation. */
  mode?: AiVideoMode;
  /**
   * The finished video the mode works from, as a URL the provider can fetch.
   * Required by every mode and meaningless without one.
   */
  sourceVideoUrl?: string;
  /**
   * Motion control only. Whether the result follows the character picture's
   * shape or the reference video's — which also decides how long it may be —
   * and how much the provider is asked to spend on it.
   */
  motionOrientation?: "image" | "video";
  motionQuality?: "standard" | "pro";
  /**
   * Omitted when the deployment has no HTTPS origin to be called back on, in
   * which case the job is finished by polling instead.
   */
  callbackUrl?: string;
  model: string;
  /**
   * Makes a re-submission of the same local job cost one generation.
   *
   * A provider that deduplicates on it turns "the transport failed and we do
   * not know whether it was accepted" from a choice between double-billing and
   * dropping a paid job into a retry that is simply safe.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
};

/**
 * Enough to ask a provider about a job it accepted.
 *
 * The model is here because the Gateway's status endpoint is addressed by
 * model as well as by job id. OpenRouter ignores it. It is nullable because a
 * row written before the model column existed has none.
 */
export type AiVideoJobRef = {
  providerJobId: string;
  model: string | null;
  /** Optional shorter deadline for background cost-only checks. */
  signal?: AbortSignal;
};

/** What a provider publishes about one video model. */
export type AiVideoModelDescriptor = {
  id: string;
  supportedResolutions: readonly string[] | null;
  supportedDurations: readonly number[] | null;
  supportedAspectRatios: readonly string[] | null;
  supportedFrameImages: readonly string[] | null;
  generateAudio: boolean | null;
  /** The model always includes audio; generating it and disabling it are distinct capabilities. */
  audioRequired?: boolean;
  seed: boolean | null;
  /**
   * Whether the model takes reference pictures to keep a likeness consistent.
   * Null when the provider states nothing; false where it has no such surface
   * at all, which is the case for everything OpenRouter offers.
   */
  supportsReferenceToVideo: boolean | null;
  /** Rewrites a video it is given, from a description of the change. */
  supportsVideoEditing: boolean | null;
  /** Continues a video it is given, from where it left off. */
  supportsVideoExtension: boolean | null;
  /** Transfers the motion of a video it is given onto a character picture. */
  supportsMotionControl: boolean | null;
  /**
   * Whether the model will turn a prompt (with or without a starting frame)
   * into a video at all.
   *
   * Null when the provider says nothing. False is for a model that exists but
   * serves some other task — the Gateway lists motion-control models that
   * publish resolutions, lengths and shapes like any other, and offering one
   * for an ordinary generation produces a request it can only refuse.
   */
  supportsPromptToVideo: boolean | null;
  /**
   * What the model will take as input, as it publishes it.
   *
   * Null for a field the provider says nothing about, which means "no stated
   * restriction" rather than "none allowed" — the service's own ceilings still
   * apply on top, and they are what a price was set against.
   */
  inputLimits: AiVideoModelInputLimits;
};

/** The counts and sizes one model accepts, before this service's own ceilings. */
export type AiVideoModelInputLimits = {
  /** Reference and frame pictures, together. */
  maxImages: number | null;
  maxImageBytes: number | null;
  /** Source videos, for the modes that work from one. */
  maxVideos: number | null;
  maxVideoBytes: number | null;
  minVideoDurationSeconds: number | null;
  maxVideoDurationSeconds: number | null;
  /**
   * Sound the model conditions on.
   *
   * Thirteen models publish an allowance for it. The SDK has no field of its
   * own — `generateAudio` is about the output — so it travels in the same
   * reference list as pictures and clips, which the SDK normalizes without
   * restricting the media type.
   */
  maxAudio: number | null;
  maxAudioBytes: number | null;
  minAudioDurationSeconds: number | null;
  maxAudioDurationSeconds: number | null;
  /**
   * How long a prompt the model reads.
   *
   * Worth honouring in both directions: several models take fewer characters
   * than this service's own limit, so a prompt it accepts is one they refuse.
   */
  maxPromptCharacters: number | null;
  /** Every input together, where the provider caps them jointly. */
  maxTotalInputs: number | null;
};

/** Nothing stated, which is how a provider that publishes no limits is read. */
export const UNSTATED_VIDEO_INPUT_LIMITS: AiVideoModelInputLimits = {
  maxImages: null,
  maxImageBytes: null,
  maxVideos: null,
  maxVideoBytes: null,
  minVideoDurationSeconds: null,
  maxVideoDurationSeconds: null,
  maxAudio: null,
  maxAudioBytes: null,
  minAudioDurationSeconds: null,
  maxAudioDurationSeconds: null,
  maxPromptCharacters: null,
  maxTotalInputs: null,
};

export interface AiVideoProvider {
  start(request: AiVideoStartRequest): Promise<AiVideoJobInfo>;
  status(ref: AiVideoJobRef): Promise<AiVideoJobInfo>;
  /**
   * Takes the job rather than its id: the Gateway's bytes arrive with the
   * status and cannot be fetched again from an id alone.
   */
  download(job: AiVideoJobInfo, ref: AiVideoJobRef): Promise<AiVideoContent>;
  /** Every video model this provider offers, with the capabilities it publishes. */
  listModels(): Promise<AiVideoModelDescriptor[]>;
  /** How long a poll may hold its lease: the provider's request timeout plus a margin. */
  pollLeaseMilliseconds(): number;
  /**
   * Whether pictures must be reachable by URL rather than inlined.
   *
   * True for a provider that persists the submission to run it in the
   * background and caps what it will persist: an inlined picture passes that
   * cap and the submission is refused. The submission path uploads them and
   * rewrites the request when this is set.
   */
  readonly requiresHostedMedia: boolean;
}

/* ------------------------------------------------------------------ image */

export type ImageReference = {
  bytes: ArrayBuffer;
  mimeType: string;
};

export type GeneratedImage = {
  b64Json: string;
  mediaType: string;
  providerCostUsd?: ProviderCostUsd;
};

/** A rough version of the picture, sent while the final one is still coming. */
export type PartialImage = {
  /** 0-based. */
  index: number;
  b64Json: string;
};

export type AiImageGenerateRequest = {
  prompt: string;
  aspectRatio: AiImageAspectRatio;
  /** Selected by the administrator for this registered operation/model row. */
  imageSizeMode?: import("@beutl/core").AiImageSizeMode;
  background?: AiImageBackground;
  referenceImages?: ImageReference[];
  seed?: number;
  model: string;
  signal?: AbortSignal;
  onPartialImage?: (partial: PartialImage) => void;
};

export type AiImageEditRequest = {
  task: string;
  image: ArrayBuffer;
  mimeType: string;
  prompt?: string;
  model: string;
  signal?: AbortSignal;
};

export interface AiImageProvider {
  generate(request: AiImageGenerateRequest): Promise<GeneratedImage>;
  edit(request: AiImageEditRequest): Promise<GeneratedImage>;
}

/* ---------------------------------------------------------- transcription */

export type AiTranscribeRequest = {
  audio: ArrayBuffer;
  durationSeconds: number;
  filename: string;
  mimeType: string;
  language?: string;
  model: string;
  signal?: AbortSignal;
};

export interface AiTranscriptionProvider {
  transcribe(request: AiTranscribeRequest): Promise<TranscriptionResult>;
}

/* ------------------------------------------------------------ translation */

export type TranslationSegment = {
  id: string;
  text: string;
};

export type TranslationStyle = {
  /** Term to the translation it must be given. */
  glossary?: Record<string, string>;
  maxCharactersPerLine?: number;
  maxLines?: number;
};

export type TranslationSegmentContext = {
  start: number;
  end: number;
};

export type AiTranslationResult = TranslationSegment[] & {
  providerCostUsd?: ProviderCostUsd;
};

export type AiTranslateRequest = {
  sourceLanguage?: string;
  targetLanguage: string;
  segments: TranslationSegment[];
  /** Keyed by segment id. */
  contexts?: Record<string, TranslationSegmentContext>;
  style?: TranslationStyle;
  model: string;
  signal?: AbortSignal;
  onSegment?: (segment: TranslationSegment) => void;
};

export interface AiTranslationProvider {
  translate(request: AiTranslateRequest): Promise<AiTranslationResult>;
}

/* --------------------------------------------------------------- provider */

export interface AiProvider {
  readonly id: AiProviderId;
  readonly video?: AiVideoProvider;
  readonly image?: AiImageProvider;
  readonly transcription?: AiTranscriptionProvider;
  readonly translation?: AiTranslationProvider;
  /** Whether this provider can run the operation at all. */
  supports(operation: string): boolean;
  /**
   * Whether this deployment holds what the provider needs to be called.
   *
   * Only credentials, which are read from the environment and never change
   * within a request. It is deliberately not a reachability check: a provider
   * that is configured but momentarily down must keep its models on offer, or
   * an outage would silently unregister them.
   */
  isConfigured(): boolean;
  /**
   * Which side of the refund line a failure falls on. Getting this wrong bills
   * a user twice or drops a job they paid for, so every provider classifies
   * its own transport and status codes rather than sharing one guess.
   */
  executionOf(cause: unknown): AiExecutionOutcome;
  /**
   * The longest a submitted job can still deliver a usable result. Past it, a
   * job whose id never reached us is refunded instead of holding reserved units.
   */
  maximumVideoJobMilliseconds(): number;
}

/**
 * The key a capability map is stored under.
 *
 * A model id alone is not unique across the catalog: `AiOperationModel` is keyed
 * by `(operation, modelId)`, so the same underlying id can be registered
 * against OpenRouter for one operation and against the Gateway for another.
 * Those two entries describe different endpoints with different limits, and
 * merging them by id alone silently hands one provider's allowances to the
 * other — a request validated against the wrong ceiling, then refused after the
 * usage was reserved.
 *
 * Provider ids are a closed set and none is a prefix of another, so joining on
 * a colon stays unambiguous even though a model id may itself contain one
 * (`openai/gpt-4o:extended`). Nothing splits this key back apart.
 */
export function aiCapabilityKey(
  // A plain string, not `AiProviderId`: catalog rows carry whatever an
  // administrator stored, and a key is a join, not a validation.
  provider: string,
  modelId: string,
): string {
  return `${provider}:${modelId}`;
}
