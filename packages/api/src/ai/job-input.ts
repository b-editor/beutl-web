import { z } from "zod";
import {
  MAX_AI_PROMPT_LENGTH,
  AI_IMAGE_ASPECT_RATIOS,
  AI_IMAGE_BACKGROUNDS,
  AI_IMAGE_EDIT_TASKS,
  AI_LEGACY_IMAGE_SIZES,
  AI_MAX_SEED,
  AI_MIN_SEED,
  AI_VIDEO_ASPECT_RATIOS,
  AI_VIDEO_RESOLUTIONS,
  isAiVideoDurationSeconds,
} from "@beutl/core";

// Jobs created before aspect ratios existed carry `size`; new ones carry
// `aspectRatio`. Exactly one is required so a retry has an unambiguous shape.
const imageRetryInputSchema = z
  .object({
    prompt: z.string().trim().min(1).max(MAX_AI_PROMPT_LENGTH),
    size: z.enum(AI_LEGACY_IMAGE_SIZES).optional(),
    aspectRatio: z.enum(AI_IMAGE_ASPECT_RATIOS).optional(),
    background: z.enum(AI_IMAGE_BACKGROUNDS).optional(),
    seed: z.number().int().min(AI_MIN_SEED).max(AI_MAX_SEED).optional(),
    // Only the names are kept; the pictures themselves are not, which is what
    // closes retry for a reference-guided generation. "reference" is what jobs
    // recorded while only one was allowed.
    reference: z.object({ filename: z.string().min(1) }).optional(),
    references: z
      .array(z.object({ filename: z.string().min(1) }))
      .optional(),
  })
  .refine(
    (value) =>
      (value.size !== undefined) !== (value.aspectRatio !== undefined),
  );

// A frame-conditioned video records which images it started from. The bytes are
// not kept, so such a job cannot be rerun — but the history has to say the
// frames were there, or it reads as a plain text-to-video job.
const videoFrameHistorySchema = z.object({
  filename: z.string().min(1),
  mimeType: z.string().min(1),
}).strict();

const videoHistoryInputSchema = z.object({
  prompt: z.string().trim().min(1).max(MAX_AI_PROMPT_LENGTH),
  durationSeconds: z.number().refine(isAiVideoDurationSeconds).default(4),
  resolution: z.enum(AI_VIDEO_RESOLUTIONS).default("720p"),
  aspectRatio: z.enum(AI_VIDEO_ASPECT_RATIOS).default("16:9"),
  generateAudio: z.boolean().default(true),
  seed: z.number().int().min(AI_MIN_SEED).max(AI_MAX_SEED).optional(),
  firstFrame: videoFrameHistorySchema.optional(),
  lastFrame: videoFrameHistorySchema.optional(),
});

const imageEditHistoryInputSchema = z.object({
  task: z.enum(AI_IMAGE_EDIT_TASKS),
  prompt: z.string().trim().min(1).max(MAX_AI_PROMPT_LENGTH).optional(),
});

const transcriptionHistoryInputSchema = z.object({
  durationSeconds: z.number().finite().nonnegative(),
  language: z.string().length(2).optional(),
});

const translationHistoryInputSchema = z.object({
  sourceLanguage: z.string().length(2).optional(),
  targetLanguage: z.string().length(2),
  segmentCount: z.number().int().positive(),
  characterCount: z.number().int().positive(),
});

const VIDEO_REPLAY_KEYS = ["prompt", "durationSeconds", "resolution", "aspectRatio", "generateAudio", "seed"] as const;

function canonicalVideoReplayInput(input: unknown, includeFrames = false): { success: true; data: Record<string, unknown> } | { success: false } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { success: false };
  const source = input as Record<string, unknown>;
  if (typeof source.prompt !== "string" || source.prompt.length === 0 || source.prompt.length > MAX_AI_PROMPT_LENGTH || source.prompt !== source.prompt.trim()) return { success: false };
  const parsed = videoHistoryInputSchema.safeParse(input);
  const keys = Object.keys(source);
  const allowed = new Set([...VIDEO_REPLAY_KEYS, "firstFrame", "lastFrame"]);
  if (!parsed.success || keys.some((key) => !allowed.has(key)) || (!includeFrames && (keys.includes("firstFrame") || keys.includes("lastFrame")))) {
    return { success: false };
  }
  const data: Record<string, unknown> = {};
  for (const key of VIDEO_REPLAY_KEYS) {
    if (source[key] !== undefined) data[key] = source[key];
  }
  if (includeFrames) {
    for (const key of ["firstFrame", "lastFrame"] as const) {
      if (source[key] !== undefined) data[key] = parsed.data[key];
    }
  }
  if (data.durationSeconds === undefined) data.durationSeconds = 4;
  if (data.resolution === undefined) data.resolution = "720p";
  if (data.aspectRatio === undefined) data.aspectRatio = "16:9";
  if (data.generateAudio === undefined) data.generateAudio = true;
  return { success: true, data };
}

/** Validate the exact persisted input shape that the dashboard retry action can replay. */
export function parseReplayableAiJobInput(
  kind: string,
  input: unknown,
): { success: true; data: { prompt: string; [key: string]: unknown } } | { success: false } {
  if (kind === "image") {
    const parsed = imageRetryInputSchema.safeParse(input);
    const source = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : null;
    const keys = source ? Object.keys(source) : [];
    const allowed = new Set(["prompt", "size", "aspectRatio", "background", "seed", "reference", "references"]);
    if (
      !parsed.success ||
      typeof source?.prompt !== "string" ||
      source.prompt !== source.prompt.trim() ||
      keys.some((key) => !allowed.has(key)) ||
      keys.includes("reference") ||
      keys.includes("references")
    ) {
      return { success: false };
    }
    return { success: true, data: input as { prompt: string; [key: string]: unknown } };
  }
  if (kind === "video") {
    const canonical = canonicalVideoReplayInput(input);
    return canonical.success ? { success: true, data: canonical.data as { prompt: string; [key: string]: unknown } } : canonical;
  }
  return { success: false };
}

/** Return the same allow-listed, canonical history payload used by the API. */
export function sanitizeAiJobInputParams(kind: string, input: unknown): Record<string, unknown> | null {
  if (kind === "image" && input && typeof input === "object" && !Array.isArray(input)) {
    const source = input as Record<string, unknown>;
    const parsed = imageRetryInputSchema.safeParse(input);
    if (
      !parsed.success ||
      typeof source.prompt !== "string" ||
      source.prompt !== source.prompt.trim()
    ) return null;
    const result: Record<string, unknown> = { prompt: source.prompt };
    for (const key of ["size", "aspectRatio", "background", "seed"] as const) {
      if (source[key] !== undefined) result[key] = source[key];
    }
    if (parsed.data.reference !== undefined) result.reference = parsed.data.reference;
    if (parsed.data.references !== undefined) result.references = parsed.data.references;
    return result;
  }
  const parsed = (() => {
    switch (kind) {
      case "image": {
        const result = imageRetryInputSchema.safeParse(input);
        if (!result.success) return result;
        return result;
      }
      case "image_edit": return imageEditHistoryInputSchema.safeParse(input);
      case "video": {
        const canonical = canonicalVideoReplayInput(input, true);
        return canonical.success ? canonical : null;
      }
      case "stt": return transcriptionHistoryInputSchema.safeParse(input);
      case "translation": return translationHistoryInputSchema.safeParse(input);
      default: return null;
    }
  })();
  return parsed?.success ? parsed.data : null;
}
