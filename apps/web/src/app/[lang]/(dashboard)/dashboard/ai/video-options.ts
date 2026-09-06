import {
  isVideoModelUsable,
  type AiVideoModelCapabilities,
} from "@beutl/api/ai/video-model-capabilities";
import type { AiAccess, AiScreenModel } from "./shared";
import type { AiVideoModelOptions } from "./video-form";

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
  // A model the provider says nothing about is treated as unrestricted, so an
  // outage at the provider leaves every registered model in place. Reaching
  // none therefore means the models really cannot serve this, and putting the
  // registered ones back would only offer a submit that is certain to be
  // refused.
  const modelOptions: Record<string, AiVideoModelOptions> = Object.fromEntries(
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
              },
            ],
          ]
        : [];
    }),
  );

  return { models, modelOptions };
}
