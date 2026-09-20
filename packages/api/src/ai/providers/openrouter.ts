// OpenRouter as one provider among others.
//
// This is an adapter, not a move: ../openrouter and ../openrouter-video keep
// their paths and their contents. Relocating them would buy a tidier tree and
// cost every `vi.mock("…/ai/openrouter-video")` in the contract tests, and the
// seam this file creates is the point, not the file layout. Leaving them put
// also means those mocks reach through this adapter unchanged.

import { AI_OPERATIONS } from "@beutl/core";
import {
  AI_SOURCE_VIDEO_OPERATIONS,
  UNSTATED_VIDEO_INPUT_LIMITS,
} from "./types";
import {
  AiProviderError,
  downloadVideoContent,
  editImage,
  generateImage,
  getOpenRouterRequestTimeoutMilliseconds,
  openRouterExecutionOf,
  transcribeAudio,
  translateSegments,
  type ImageEditTask,
} from "../openrouter";
import {
  createVideoJob,
  getVideoJob,
  listVideoModels,
} from "../openrouter-video";
import type { AiExecutionOutcome } from "./errors";
import type { TranscriptionResult } from "../audio-validation";
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
} from "./types";

// A poll must not release its lease while the request it is waiting on can
// still answer, so the lease outlives the provider's own timeout.
export const PROVIDER_POLL_LEASE_MARGIN_MILLISECONDS = 30 * 1000;

// The longest OpenRouter keeps a video job. Past it no usable result can still
// arrive, so a submission whose id never reached us stops holding a slot.
const MAXIMUM_VIDEO_JOB_MILLISECONDS = 6 * 60 * 60 * 1000;

const video: AiVideoProvider = {
  start(request: AiVideoStartRequest): Promise<AiVideoJobInfo> {
    return createVideoJob(request);
  },

  // OpenRouter addresses a job by its id alone; the model is the Gateway's
  // requirement and is ignored here.
  status(ref: AiVideoJobRef): Promise<AiVideoJobInfo> {
    return getVideoJob(ref.providerJobId);
  },

  download(_job: AiVideoJobInfo, ref: AiVideoJobRef): Promise<AiVideoContent> {
    return downloadVideoContent(ref.providerJobId);
  },

  async listModels(): Promise<AiVideoModelDescriptor[]> {
    const models = await listVideoModels();
    // OpenRouter publishes no notion of what task a video model serves, and
    // every model it lists generates from a prompt. Null says "not stated"
    // rather than asserting it. Reference pictures are a definite no: its video
    // API has no field for them at all.
    return models.map((model) => ({
      ...model,
      supportsPromptToVideo: null,
      // Its video API has no field for a reference picture or a source video.
      supportsReferenceToVideo: false,
      supportsVideoEditing: false,
      supportsVideoExtension: false,
      supportsMotionControl: false,
      // OpenRouter publishes no input allowances at all, so nothing is stated
      // and the service's own ceilings are the only ones that apply.
      inputLimits: UNSTATED_VIDEO_INPUT_LIMITS,
    }));
  },

  // OpenRouter reads the picture out of the submission itself, so the bytes
  // travel with it and never need a home of their own.
  requiresHostedMedia: false,

  pollLeaseMilliseconds(): number {
    const timeout = getOpenRouterRequestTimeoutMilliseconds();
    if (
      timeout >
      Number.MAX_SAFE_INTEGER - PROVIDER_POLL_LEASE_MARGIN_MILLISECONDS
    ) {
      throw new AiProviderError(
        "OPENROUTER_REQUEST_TIMEOUT_MS is too large for a safe provider poll lease",
      );
    }
    return timeout + PROVIDER_POLL_LEASE_MARGIN_MILLISECONDS;
  },
};

const image: AiImageProvider = {
  generate(request: AiImageGenerateRequest): Promise<GeneratedImage> {
    return generateImage(request);
  },
  edit(request: AiImageEditRequest): Promise<GeneratedImage> {
    // The task list is the catalog's, which is checked against
    // AI_IMAGE_EDIT_TASKS before a request reaches a provider.
    return editImage({ ...request, task: request.task as ImageEditTask });
  },
};

const transcription: AiTranscriptionProvider = {
  transcribe(request: AiTranscribeRequest): Promise<TranscriptionResult> {
    return transcribeAudio(request);
  },
};

const translation: AiTranslationProvider = {
  translate(request: AiTranslateRequest): Promise<TranslationSegment[]> {
    return translateSegments(request);
  },
};

export const openRouterProvider: AiProvider = {
  id: "openrouter",
  video,
  image,
  transcription,
  translation,

  // Everything except the three modes that work from a video this service
  // already holds: OpenRouter's video API has no field for a source video, so
  // a model registered for one of them could only ever be refused.
  supports(operation: string): boolean {
    return (
      (AI_OPERATIONS as readonly string[]).includes(operation) &&
      !AI_SOURCE_VIDEO_OPERATIONS.has(operation)
    );
  },

  executionOf(cause: unknown): AiExecutionOutcome {
    return openRouterExecutionOf(cause);
  },

  maximumVideoJobMilliseconds(): number {
    return MAXIMUM_VIDEO_JOB_MILLISECONDS;
  },
};
