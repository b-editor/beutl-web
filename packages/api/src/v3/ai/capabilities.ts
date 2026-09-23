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
  MAX_AI_VIDEO_DURATION_SECONDS,
  MIN_AI_VIDEO_DURATION_SECONDS,
  AI_VIDEO_RESOLUTIONS,
  AI_MAX_VIDEO_INPUT_REFERENCES,
  MAX_AI_VIDEO_INPUT_REFERENCES_TOTAL_BYTES,
} from "@beutl/core";
import { getUserId } from "../../api/auth";
import { apiErrorResponse } from "../../api/error";
import { loadAiModelCatalog } from "../../ai/model-catalog";
import { providerRequiresPreparedOutpaintCanvas } from "../../ai/providers/registry";
import {
  isVideoModelUsable,
  loadAiVideoModelCapabilities,
  videoCapabilityOf,
} from "../../ai/video-model-capabilities";
import {
  imageCapabilityOf,
  loadAiImageModelCapabilities,
} from "../../ai/image-model-capabilities";
import {
  MAX_AI_IMAGE_REFERENCES_TOTAL_BYTES,
  MAX_AI_IMAGE_UPLOAD_BYTES,
  MAX_AI_PROMPT_LENGTH,
  MAX_AI_TRANSCRIPTION_UPLOAD_BYTES,
  MAX_AI_TRANSLATION_JSON_REQUEST_BYTES,
  MAX_AI_SOURCE_VIDEO_UPLOAD_BYTES,
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

type SourceVideoModelDescription = ModelDescription & {
  durationsSeconds?: number[];
  maxPromptLength: number;
  maxSourceVideoBytes: number;
  minSourceVideoSeconds: number | null;
  maxSourceVideoSeconds: number | null;
  maxCharacterImageBytes?: number;
};

// A video model states its own accepted parameters. The operation-level lists
// remain the superset the server will take at all; a request has to satisfy the
// model it names as well, and one that does not is refused before it is
// charged. A model whose lists are empty accepts nothing this service can ask
// for and is registered but unusable.
// An image model states its own accepted shapes for the same reason a video
// model does: GPT Image-1 takes 1:1, 3:2 and 2:3 and refuses everything else,
// and models differ over which backgrounds they publish, whether they take a
// seed, and whether they accept a picture to work from.
type ImageModelDescription = ModelDescription & {
  aspectRatios: string[];
  backgrounds: string[];
  seed: boolean;
  maxReferenceImages: number;
  // 拡大（upscale）が頼めるか。これが分からないと、クライアントは対応しない
  // モデルを選ばせて拒否されるまで気づけない。
  resolution: boolean;
};

type VideoModelDescription = ModelDescription & {
  durationsSeconds: number[];
  resolutions: string[];
  aspectRatios: string[];
  audio: boolean;
  audioRequired: boolean;
  seed: boolean;
  // 開始フレームと終了フレームは別々に扱う。片方しか取らないモデルがある。
  firstFrame: boolean;
  lastFrame: boolean;
  // 参照画像で人物や物の見た目を揃えられるか。フレームとは排他で、両方渡すと
  // 参照のほうが黙って捨てられる。
  inputReferences: boolean;
  // このモデルが実際に受け取る量。公開していないモデルではサービスの天井が
  // そのまま入る。画面はこれを見て欄を出す——一律の数字で切ると、9 枚取れる
  // モデルに 3 枚しか渡せない。
  maxInputReferences: number;
  maxInputReferenceBytes: number;
  maxSourceVideoBytes: number;
  minSourceVideoSeconds: number | null;
  maxSourceVideoSeconds: number | null;
  maxPromptLength: number;
  // 参照として運べる動画と音声。画像とは別枠。0 はそのモデルが取らないこと。
  maxVideoReferences: number;
  maxVideoReferenceBytes: number;
  maxAudioReferences: number;
  maxAudioReferenceBytes: number;
  // 種類ごとに収まっていても、合計でこれを超える組み合わせは受け取らない。
  // null は「合計の制限を公開していない」。画面がこれを見ないと、どの欄も
  // 上限内なのに送信だけが 400 で返る組み方ができてしまう。
  maxTotalReferences: number | null;
};

// The provider rides along so a caller can look the entry's capabilities up.
// It is not part of the response: a client picks a model, never a provider, and
// describeModels drops it for the operations that publish nothing else.
function describeCatalogEntries(
  catalog: Awaited<ReturnType<typeof loadAiModelCatalog>>,
  operation: string,
): (ModelDescription & { provider: string; videoAudioRequired: boolean | null })[] {
  const entries = catalog.list(operation);
  return entries.map((entry, index) => ({
    id: entry.modelId,
    displayName: entry.displayName,
    costTier: entry.costTier,
    // The one a request that names no model runs on.
    isDefault: index === 0,
    provider: entry.provider,
    videoAudioRequired: entry.videoAudioRequired,
  })).filter((entry) => !providerRequiresPreparedOutpaintCanvas(entry.provider, operation));
}

function describeModels(
  catalog: Awaited<ReturnType<typeof loadAiModelCatalog>>,
  operation: string,
): ModelDescription[] {
  return describeCatalogEntries(catalog, operation).map(
    ({ provider: _provider, videoAudioRequired: _audioRequired, ...model }) => model,
  );
}

const app = new Hono().get("/", async (c) => {
  const userId = await getUserId(c);
  if (!userId) {
    return c.json(await apiErrorResponse("authenticationIsRequired"), {
      status: 401,
    });
  }

  const catalog = await loadAiModelCatalog();
  const imageOperations = [
    "image.generate",
    ...AI_IMAGE_EDIT_TASKS.map((task) => `image.edit.${task}`),
  ];
  const [videoCapabilities, imageCapabilities] = await Promise.all([
    loadAiVideoModelCapabilities(),
    loadAiImageModelCapabilities(
      // The whole entry, not just the id: what a model accepts depends on who
      // runs it, and the Gateway publishes nothing per model to discover it
      // from.
      imageOperations.flatMap((operation) => catalog.list(operation)),
    ),
  ]);
  const describeImageModels = (operation: string): ImageModelDescription[] =>
    describeCatalogEntries(catalog, operation).map(({ provider, videoAudioRequired: _audioRequired, ...model }) => {
      const supported = imageCapabilityOf(imageCapabilities, {
        modelId: model.id,
        provider,
      });
      return {
        ...model,
        aspectRatios: supported
          ? supported.aspectRatios
          : [...AI_IMAGE_ASPECT_RATIOS],
        backgrounds: supported ? supported.backgrounds : [...AI_IMAGE_BACKGROUNDS],
        seed: supported ? supported.seed : true,
        maxReferenceImages: supported
          ? supported.maxReferenceImages
          : AI_MAX_IMAGE_REFERENCES,
        resolution: supported ? supported.resolution : true,
      };
    });
  // A mode that works from a video needs nothing but "can this model do it":
  // the shape and, for an edit, the length come from the source.
  const describeSourceVideoModels = (operation: string): SourceVideoModelDescription[] =>
    describeCatalogEntries(catalog, operation).filter((model) =>
      isVideoModelUsable(
        videoCapabilityOf(videoCapabilities, {
          modelId: model.id,
          provider: model.provider,
          videoAudioRequired: model.videoAudioRequired,
        }),
        operation,
      ),
    ).map(({ provider, videoAudioRequired, ...model }) => {
      const supported = videoCapabilityOf(videoCapabilities, {
        modelId: model.id,
        provider,
        videoAudioRequired,
      });
      return {
        ...model,
        ...(operation === "video.edit" ? {} : {
          durationsSeconds: supported?.durations.length ? supported.durations : [...AI_VIDEO_DURATIONS_SECONDS],
        }),
        maxPromptLength: supported?.maxPromptCharacters ?? MAX_AI_PROMPT_LENGTH,
        maxSourceVideoBytes: supported?.maxSourceVideoBytes ?? MAX_AI_SOURCE_VIDEO_UPLOAD_BYTES,
        minSourceVideoSeconds: supported?.minSourceVideoSeconds ?? null,
        maxSourceVideoSeconds: supported?.maxSourceVideoSeconds ?? null,
        ...(operation === "video.motion" ? {
          maxCharacterImageBytes: Math.min(
            supported?.maxReferenceBytes ?? MAX_AI_VIDEO_FRAME_UPLOAD_BYTES,
            MAX_AI_VIDEO_FRAME_UPLOAD_BYTES,
          ),
        } : {}),
      };
    });
  const videoModels: VideoModelDescription[] = describeCatalogEntries(
    catalog,
    "video.generate",
  ).filter((model) =>
    isVideoModelUsable(
      videoCapabilityOf(videoCapabilities, {
        modelId: model.id,
        provider: model.provider,
        videoAudioRequired: model.videoAudioRequired,
      }),
      "video.generate",
    ),
  ).map(({ provider, videoAudioRequired, ...model }) => {
    const supported = videoCapabilityOf(videoCapabilities, {
      modelId: model.id,
      provider,
      videoAudioRequired,
    });
    return {
      ...model,
      promptToVideo: supported?.promptToVideo ?? true,
      durationsSeconds: supported
        ? supported.durations
        : [...AI_VIDEO_DURATIONS_SECONDS],
      resolutions: supported ? supported.resolutions : [...AI_VIDEO_RESOLUTIONS],
      aspectRatios: supported
        ? supported.aspectRatios
        : [...AI_VIDEO_ASPECT_RATIOS],
      audio: supported ? supported.generateAudio : true,
      audioRequired: supported?.audioRequired ?? false,
      seed: supported ? supported.seed : true,
      firstFrame: supported ? supported.firstFrame : true,
      lastFrame: supported ? supported.lastFrame : true,
      // 既定は false。取れないモデルに送っても黙って無視されるだけなので、
      // 「分からない＝出す」にはしない。
      inputReferences: supported ? supported.referenceToVideo : false,
      maxInputReferences: supported
        ? supported.maxInputReferences
        : AI_MAX_VIDEO_INPUT_REFERENCES,
      maxInputReferenceBytes: supported
        ? supported.maxReferenceBytes
        : MAX_AI_VIDEO_FRAME_UPLOAD_BYTES,
      maxSourceVideoBytes: supported
        ? supported.maxSourceVideoBytes
        : MAX_AI_SOURCE_VIDEO_UPLOAD_BYTES,
      minSourceVideoSeconds: supported ? supported.minSourceVideoSeconds : null,
      maxSourceVideoSeconds: supported ? supported.maxSourceVideoSeconds : null,
      maxPromptLength: supported
        ? supported.maxPromptCharacters
        : MAX_AI_PROMPT_LENGTH,
      maxVideoReferences: supported ? supported.maxVideoReferences : 0,
      maxVideoReferenceBytes: supported ? supported.maxVideoReferenceBytes : 0,
      maxAudioReferences: supported ? supported.maxAudioReferences : 0,
      maxAudioReferenceBytes: supported ? supported.maxAudioReferenceBytes : 0,
      maxTotalReferences: supported ? supported.maxTotalReferences : null,
    };
  });
  return c.json({
    // Keyed exactly like `availability` in the entitlements response, so a
    // client can line the two up without a mapping table.
    operations: {
      "image.generate": {
        models: describeImageModels("image.generate"),
        maxPromptLength: MAX_AI_PROMPT_LENGTH,
        aspectRatios: AI_IMAGE_ASPECT_RATIOS,
        // Accepted for compatibility; each maps onto the ratio it always meant.
        legacySizes: AI_LEGACY_IMAGE_SIZES,
        backgrounds: AI_IMAGE_BACKGROUNDS,
        maxReferenceImages: AI_MAX_IMAGE_REFERENCES,
        maxReferenceImageBytes: MAX_AI_IMAGE_UPLOAD_BYTES,
        // 1 枚ごとの上限とは別に、全部あわせてこの大きさまで。枚数分を掛けた
        // 総量は Worker が保持しきれないので、掛け算では読めない値として出す。
        maxReferenceImagesTotalBytes: MAX_AI_IMAGE_REFERENCES_TOTAL_BYTES,
        outputFormat: "png",
        seed,
      },
      ...Object.fromEntries(
        AI_IMAGE_EDIT_TASKS.map((task) => [
          `image.edit.${task}`,
          {
            models: describeImageModels(`image.edit.${task}`),
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
      // Working from a video this service already holds. Only the models that
      // publish the mode are listed, because one that does not would drop the
      // source and bill for something else.
      "video.edit": {
        models: describeSourceVideoModels("video.edit"),
        maxPromptLength: MAX_AI_PROMPT_LENGTH,
        // The result is as long as its source, so nothing is chosen here.
        durationFollowsSource: true,
      },
      "video.extend": {
        models: describeSourceVideoModels("video.extend"),
        maxPromptLength: MAX_AI_PROMPT_LENGTH,
        // The length of the added segment, not of the whole result.
        minDurationSeconds: MIN_AI_VIDEO_DURATION_SECONDS,
        maxDurationSeconds: MAX_AI_VIDEO_DURATION_SECONDS,
      },
      "video.motion": {
        models: describeSourceVideoModels("video.motion"),
        maxPromptLength: MAX_AI_PROMPT_LENGTH,
        minDurationSeconds: MIN_AI_VIDEO_DURATION_SECONDS,
        maxDurationSeconds: MAX_AI_VIDEO_DURATION_SECONDS,
        orientations: ["image", "video"],
        qualities: ["standard", "pro"],
        maxCharacterImageBytes: MAX_AI_VIDEO_FRAME_UPLOAD_BYTES,
      },
      "video.generate": {
        models: videoModels,
        maxPromptLength: MAX_AI_PROMPT_LENGTH,
        // The span the server will consider; which seconds a given model takes
        // is on that model's own entry above.
        minDurationSeconds: MIN_AI_VIDEO_DURATION_SECONDS,
        maxDurationSeconds: MAX_AI_VIDEO_DURATION_SECONDS,
        resolutions: AI_VIDEO_RESOLUTIONS,
        aspectRatios: AI_VIDEO_ASPECT_RATIOS,
        audio: true,
        seed,
        maxFrameImageBytes: MAX_AI_VIDEO_FRAME_UPLOAD_BYTES,
        frameTypes: ["first_frame", "last_frame"],
        // 参照画像の上限。フレームと同じ大きさで、枚数はモデル側の公開値に
        // 関わらずこの数まで。フレームと同時には送れない。
        maxInputReferences: AI_MAX_VIDEO_INPUT_REFERENCES,
        maxInputReferencesTotalBytes: MAX_AI_VIDEO_INPUT_REFERENCES_TOTAL_BYTES,
        maxInputReferenceBytes: MAX_AI_VIDEO_FRAME_UPLOAD_BYTES,
      },
    },
  });
});

export default app;
