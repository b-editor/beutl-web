// Vercel AI Gateway as a provider.
//
// `supports` is deliberately not "everything". Prompt-driven image editing
// covers restyling, object removal and outpainting. Background removal also uses
// that editing surface, with a provider option requesting transparent PNG
// output; per-model capabilities decide whether that option is available.
// Upscaling still has no equivalent here, so it remains on OpenRouter.

import type { AiExecutionOutcome } from "../errors";
import { AiProviderError } from "../errors";
import type {
  AiImageEditRequest,
  AiImageGenerateRequest,
  AiImageProvider,
  AiProvider,
  AiTranscribeRequest,
  AiTranscriptionProvider,
  AiTranslateRequest,
  AiTranslationProvider,
  GeneratedImage,
  TranslationSegment,
  AiVideoContent,
  AiVideoJobInfo,
  AiVideoJobRef,
  AiVideoModelDescriptor,
  AiVideoProvider,
  AiVideoStartRequest,
} from "../types";
import type { TranscriptionResult } from "../../audio-validation";
import { getGatewayRequestTimeoutMilliseconds } from "./config";
import { editGatewayImage, generateGatewayImage } from "./image";
import { listGatewayVideoModels } from "./models";
import { transcribeGatewayAudio } from "./transcription";
import { translateGatewaySegments } from "./translation";
import { gatewayExecutionOf } from "./errors";
import {
  downloadGatewayVideoContent,
  getGatewayVideoJob,
  startGatewayVideoJob,
} from "./video";

// A poll must not release its lease while the request it is waiting on can
// still answer, so the lease outlives the provider's own timeout.
const POLL_LEASE_MARGIN_MILLISECONDS = 30 * 1000;

// Vercel publishes no retention window for a video job. Six hours is
// OpenRouter's, and using it keeps the one thing that matters true: a paid job
// whose id never reached us stops holding reserved units at some point rather
// than never.
const MAXIMUM_VIDEO_JOB_MILLISECONDS = 6 * 60 * 60 * 1000;

// The operations this provider can actually run.
//
// The four supported image edits are all "a picture plus an instruction".
// Outpainting receives an already-expanded transparent canvas from the web
// client; v3 raw-image uploads exclude it via the input-context check in the
// provider registry. Background removal adds OpenAI's transparent-output option,
// and the model capability check admits only models verified to accept it.
// Upscaling is different: it requires a requested output resolution, which the
// Gateway adapter still has no operation-level surface for.
const SUPPORTED_OPERATIONS = new Set([
  "video.generate",
  // The three that work from a video this service already holds. Only this
  // provider has a field for a source video.
  "video.edit",
  "video.extend",
  "video.motion",
  "image.generate",
  "image.edit.remove_background",
  "image.edit.restyle",
  "image.edit.remove_object",
  "image.edit.outpaint",
  "audio.transcribe",
  "subtitle.translate",
]);

const video: AiVideoProvider = {
  start(request: AiVideoStartRequest): Promise<AiVideoJobInfo> {
    return startGatewayVideoJob(request);
  },

  status(ref: AiVideoJobRef): Promise<AiVideoJobInfo> {
    return getGatewayVideoJob(ref);
  },

  // The finished video came back with the status, so the job carries it and
  // the identifier is not consulted.
  download(job: AiVideoJobInfo): Promise<AiVideoContent> {
    return downloadGatewayVideoContent(job);
  },

  listModels(): Promise<AiVideoModelDescriptor[]> {
    return listGatewayVideoModels();
  },

  // The Gateway persists the start request to run the job in the background and
  // caps that at 300 KiB, which one inlined picture passes.
  requiresHostedMedia: true,

  pollLeaseMilliseconds(): number {
    const timeout = getGatewayRequestTimeoutMilliseconds();
    if (timeout > Number.MAX_SAFE_INTEGER - POLL_LEASE_MARGIN_MILLISECONDS) {
      throw new AiProviderError(
        "VERCEL_AI_GATEWAY_REQUEST_TIMEOUT_MS is too large for a safe provider poll lease",
      );
    }
    return timeout + POLL_LEASE_MARGIN_MILLISECONDS;
  },
};

const image: AiImageProvider = {
  generate(request: AiImageGenerateRequest): Promise<GeneratedImage> {
    return generateGatewayImage(request);
  },
  edit(request: AiImageEditRequest): Promise<GeneratedImage> {
    return editGatewayImage(request);
  },
};

const transcription: AiTranscriptionProvider = {
  transcribe(request: AiTranscribeRequest): Promise<TranscriptionResult> {
    return transcribeGatewayAudio(request);
  },
};

const translation: AiTranslationProvider = {
  translate(request: AiTranslateRequest): Promise<TranslationSegment[]> {
    return translateGatewaySegments(request);
  },
};

export const vercelGatewayProvider: AiProvider = {
  id: "vercel-gateway",
  video,
  image,
  transcription,
  translation,

  supports(operation: string): boolean {
    return SUPPORTED_OPERATIONS.has(operation);
  },

  isConfigured(): boolean {
    return Boolean(process.env.VERCEL_AI_GATEWAY_API_KEY);
  },

  executionOf(cause: unknown): AiExecutionOutcome {
    return gatewayExecutionOf(cause);
  },

  maximumVideoJobMilliseconds(): number {
    return MAXIMUM_VIDEO_JOB_MILLISECONDS;
  },
};
