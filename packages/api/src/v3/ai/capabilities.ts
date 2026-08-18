import { Hono } from "hono";
import {
  AI_IMAGE_ASPECT_RATIOS,
  AI_IMAGE_BACKGROUNDS,
  AI_IMAGE_EDIT_TASKS,
  aiImageEditTaskRequiresPrompt,
  AI_LEGACY_IMAGE_SIZES,
  AI_MAX_IMAGE_REFERENCES,
  AI_MAX_SEED,
  AI_MIN_SEED,
  AI_VIDEO_ASPECT_RATIOS,
  AI_VIDEO_DURATIONS_SECONDS,
  AI_VIDEO_RESOLUTIONS,
} from "@beutl/core";
import { getUserId } from "../../api/auth";
import { apiErrorResponse } from "../../api/error";
import { loadAiModelCatalog } from "../../ai/model-catalog";
import {
  MAX_AI_IMAGE_UPLOAD_BYTES,
  MAX_AI_PROMPT_LENGTH,
  MAX_AI_TRANSCRIPTION_UPLOAD_BYTES,
  MAX_AI_TRANSLATION_JSON_REQUEST_BYTES,
  MAX_AI_VIDEO_FRAME_UPLOAD_BYTES,
} from "../../ai/upload-limits";
import { MAX_AI_AUDIO_DURATION_SECONDS } from "../../ai/audio-metadata";
import {
  MAX_TRANSLATION_CHARACTERS,
  MAX_TRANSLATION_SEGMENTS,
} from "../../ai/subtitle-validation";

// What a client is allowed to ask for.
//
// Without this every caller had to hard-code the accepted durations, sizes and
// resolutions, and a desktop release was needed whenever the server learned a
// new one. The models an operation offers are registered by an administrator,
// so a client can only learn them from here; the ids are what a request puts in
// its `model` field.
//
// Prices are deliberately absent. What an operation costs stays server-side;
// `costTier` orders the models against each other without saying by how much,
// and whether one can be afforded right now is GET /api/v3/user/entitlements.
const seed = { min: AI_MIN_SEED, max: AI_MAX_SEED } as const;

type ModelDescription = {
  id: string;
  displayName: string;
  costTier: "low" | "medium" | "high" | null;
  isDefault: boolean;
};

function describeModels(
  catalog: Awaited<ReturnType<typeof loadAiModelCatalog>>,
  operation: string,
): ModelDescription[] {
  const entries = catalog.list(operation);
  return entries.map((entry, index) => ({
    id: entry.modelId,
    displayName: entry.displayName,
    costTier: entry.costTier,
    // The one a request that names no model runs on.
    isDefault: index === 0,
  }));
}

const app = new Hono().get("/", async (c) => {
  const userId = await getUserId(c);
  if (!userId) {
    return c.json(await apiErrorResponse("authenticationIsRequired"), {
      status: 401,
    });
  }

  const catalog = await loadAiModelCatalog();
  return c.json({
    // Keyed exactly like `availability` in the entitlements response, so a
    // client can line the two up without a mapping table.
    operations: {
      "image.generate": {
        models: describeModels(catalog, "image.generate"),
        maxPromptLength: MAX_AI_PROMPT_LENGTH,
        aspectRatios: AI_IMAGE_ASPECT_RATIOS,
        // Accepted for compatibility; each maps onto the ratio it always meant.
        legacySizes: AI_LEGACY_IMAGE_SIZES,
        backgrounds: AI_IMAGE_BACKGROUNDS,
        maxReferenceImages: AI_MAX_IMAGE_REFERENCES,
        maxReferenceImageBytes: MAX_AI_IMAGE_UPLOAD_BYTES,
        outputFormat: "png",
        seed,
      },
      ...Object.fromEntries(
        AI_IMAGE_EDIT_TASKS.map((task) => [
          `image.edit.${task}`,
          {
            models: describeModels(catalog, `image.edit.${task}`),
            maxPromptLength: MAX_AI_PROMPT_LENGTH,
            promptRequired: aiImageEditTaskRequiresPrompt(task),
            maxImageBytes: MAX_AI_IMAGE_UPLOAD_BYTES,
            outputFormat: "png",
          },
        ]),
      ),
      "audio.transcribe": {
        models: describeModels(catalog, "audio.transcribe"),
        maxUploadBytes: MAX_AI_TRANSCRIPTION_UPLOAD_BYTES,
        maxDurationSeconds: MAX_AI_AUDIO_DURATION_SECONDS,
        // Optional; omitting it lets the provider detect the language.
        languageFormat: "iso-639-1",
        // Always returned when the model supplies them.
        wordTimestamps: true,
      },
      "subtitle.translate": {
        models: describeModels(catalog, "subtitle.translate"),
        maxSegments: MAX_TRANSLATION_SEGMENTS,
        maxCharacters: MAX_TRANSLATION_CHARACTERS,
        maxRequestBytes: MAX_AI_TRANSLATION_JSON_REQUEST_BYTES,
        languageFormat: "iso-639-1",
      },
      "video.generate": {
        models: describeModels(catalog, "video.generate"),
        maxPromptLength: MAX_AI_PROMPT_LENGTH,
        durationsSeconds: AI_VIDEO_DURATIONS_SECONDS,
        resolutions: AI_VIDEO_RESOLUTIONS,
        aspectRatios: AI_VIDEO_ASPECT_RATIOS,
        audio: true,
        seed,
        maxFrameImageBytes: MAX_AI_VIDEO_FRAME_UPLOAD_BYTES,
        frameTypes: ["first_frame", "last_frame"],
      },
    },
  });
});

export default app;
