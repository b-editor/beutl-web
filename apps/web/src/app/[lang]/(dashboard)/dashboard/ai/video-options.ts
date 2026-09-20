import {
  isVideoModelUsable,
  type AiVideoModelCapabilities,
} from "@beutl/api/ai/video-model-capabilities";
import type { AiAccess, AiScreenModel } from "./shared";
import type { AiVideoModelOptions } from "./video-form";

// What a model will take, for one operation's screen. Built from the same
// capability snapshot the API checks against, so a control is offered only
// where a request carrying it would be accepted.
function optionsFor(
  models: readonly AiScreenModel[],
  capabilities: ReadonlyMap<string, AiVideoModelCapabilities>,
): Record<string, AiVideoModelOptions> {
  // A model the provider says nothing about is treated as unrestricted, so an
  // outage at the provider leaves every registered model in place. Reaching
  // none therefore means the models really cannot serve this, and putting the
  // registered ones back would only offer a submit that is certain to be
  // refused.
  return Object.fromEntries(
    models.flatMap((model) => {
      const supported = capabilities.get(model.id);
      return supported
        ? [
            [
              model.id,
              {
                resolutions: supported.resolutions,
                durations: supported.durations,
                aspectRatios: supported.aspectRatios,
                generateAudio: supported.generateAudio,
                seed: supported.seed,
                firstFrame: supported.firstFrame,
                lastFrame: supported.lastFrame,
                referenceToVideo: supported.referenceToVideo,
                maxInputReferences: supported.maxInputReferences,
                maxReferenceBytes: supported.maxReferenceBytes,
                maxSourceVideoBytes: supported.maxSourceVideoBytes,
                minSourceVideoSeconds: supported.minSourceVideoSeconds,
                maxSourceVideoSeconds: supported.maxSourceVideoSeconds,
                maxPromptCharacters: supported.maxPromptCharacters,
                maxVideoReferences: supported.maxVideoReferences,
                maxVideoReferenceBytes: supported.maxVideoReferenceBytes,
                maxAudioReferences: supported.maxAudioReferences,
                maxAudioReferenceBytes: supported.maxAudioReferenceBytes,
              },
            ],
          ]
        : [];
    }),
  );
}

export function buildAiVideoScreenOptions(
  access: AiAccess,
  capabilities: ReadonlyMap<string, AiVideoModelCapabilities>,
): {
  models: AiScreenModel[];
  modelOptions: Record<string, AiVideoModelOptions>;
} {
  // Which parameters a video may carry differs per model, so the screen offers
  // what the chosen one accepts rather than a fixed list that some models
  // refuse. A model that shares no resolution, length or aspect ratio with this
  // service is dropped: every request it could be given would be rejected.
  const registered = access.models["video.generate"] ?? [];
  const models = registered.filter((model) =>
    isVideoModelUsable(capabilities.get(model.id))
  );
  return { models, modelOptions: optionsFor(models, capabilities) };
}

/** The three modes that work from a video this service already holds. */
export type AiSourceVideoOperation =
  | "video.edit"
  | "video.extend"
  | "video.motion";

export const AI_SOURCE_VIDEO_OPERATIONS: readonly AiSourceVideoOperation[] = [
  "video.edit",
  "video.extend",
  "video.motion",
];

/**
 * The models each source-video mode can run on, and what each one takes.
 *
 * Per operation, because what makes a model usable is not a property of the
 * model alone: a motion-control model publishes no text-to-video and would be
 * dropped by the generation question, which is exactly the model video.motion
 * runs on.
 */
export function buildAiSourceVideoScreenOptions(
  access: AiAccess,
  capabilities: ReadonlyMap<string, AiVideoModelCapabilities>,
): Record<
  AiSourceVideoOperation,
  { models: AiScreenModel[]; modelOptions: Record<string, AiVideoModelOptions> }
> {
  const byOperation = AI_SOURCE_VIDEO_OPERATIONS.map((operation) => {
    const models = (access.models[operation] ?? []).filter((model) =>
      isVideoModelUsable(capabilities.get(model.id), operation),
    );
    return [
      operation,
      { models, modelOptions: optionsFor(models, capabilities) },
    ] as const;
  });
  return Object.fromEntries(byOperation) as Record<
    AiSourceVideoOperation,
    { models: AiScreenModel[]; modelOptions: Record<string, AiVideoModelOptions> }
  >;
}
