import { MAX_AI_VIDEO_FRAME_UPLOAD_BYTES, MAX_AI_VIDEO_INPUT_VIDEOS_TOTAL_BYTES, MAX_AI_VIDEO_INPUT_AUDIO_BYTES } from "@beutl/core";

/** The hash must cover every byte the reference upload can send. */
export function videoReferenceFingerprintLimit(file: File): number {
  const type = file.type.split(";", 1)[0]!.trim().toLowerCase();
  if (type === "video/mp4" || type === "video/webm") return MAX_AI_VIDEO_INPUT_VIDEOS_TOTAL_BYTES;
  if (["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3"].includes(type)) return MAX_AI_VIDEO_INPUT_AUDIO_BYTES;
  return MAX_AI_VIDEO_FRAME_UPLOAD_BYTES;
}

import { seedValue } from "./ai-screen";

/** Select and validate only reference kinds that this request can send. */
export function selectVideoReferences({
  enabled,
  kinds,
  maxTotalReferences,
}: {
  enabled: boolean;
  kinds: readonly { files: readonly File[]; maxCount: number; maxBytes: number }[];
  maxTotalReferences: number | null;
}): { files: File[]; oversized: boolean; tooMany: boolean; tooManyInTotal: boolean } {
  if (!enabled) return { files: [], oversized: false, tooMany: false, tooManyInTotal: false };
  const active = kinds.filter((kind) => kind.maxCount > 0);
  const files = active.flatMap((kind) => kind.files.slice(0, kind.maxCount));
  const tooManyInTotal = maxTotalReferences !== null && files.length > maxTotalReferences;
  return {
    files,
    oversized: active.some((kind) => kind.files.some((file) => file.size > kind.maxBytes)),
    tooMany: active.some((kind) => kind.files.length > kind.maxCount) || tooManyInTotal,
    tooManyInTotal,
  };
}

export type AiVideoOperationPath =
  | "videos"
  | "videos/frames"
  | "videos/edit"
  | "videos/extend"
  | "videos/motion";

export type AiVideoSubmission = {
  operation: AiVideoOperationPath;
  body: string | FormData;
};

/** Build the exact JSON or multipart body accepted by the v3 video API. */
export function buildAiVideoSubmission({
  prompt,
  durationSeconds,
  resolution,
  aspectRatio,
  generateAudio,
  model,
  seedEnabled,
  seedText,
  firstFrame,
  lastFrame,
  references = [],
}: {
  prompt: string;
  durationSeconds: number;
  resolution: string;
  aspectRatio: string;
  generateAudio: boolean;
  model: string;
  seedEnabled: boolean;
  seedText: string;
  firstFrame: File | null;
  lastFrame: File | null;
  // Pictures the video should keep faithful to, rather than pass through.
  // Alternatives to frames, never a combination: a provider given both ignores
  // these and warns, so the API refuses the pair outright.
  references?: readonly File[];
}): AiVideoSubmission {
  const trimmedSeed = seedText.trim();
  const normalizedSeed = seedEnabled ? seedValue(seedText) : null;
  const suppliedSeed = seedEnabled && trimmedSeed !== ""
    ? normalizedSeed ?? seedText
    : null;

  if (firstFrame || references.length > 0) {
    const body = new FormData();
    body.set("prompt", prompt);
    body.set("durationSeconds", String(durationSeconds));
    body.set("resolution", resolution);
    body.set("aspectRatio", aspectRatio);
    body.set("generateAudio", generateAudio ? "true" : "false");
    if (model) body.set("model", model);
    // Preserve an invalid non-empty value so the API rejects it before any
    // reservation instead of silently turning it into an omitted seed.
    if (suppliedSeed !== null) body.set("seed", String(suppliedSeed));
    if (firstFrame) {
      body.set("firstFrame", firstFrame);
      if (lastFrame) body.set("lastFrame", lastFrame);
    } else {
      // Repeated parts, in the order the prompt refers to them in.
      for (const reference of references) body.append("reference[]", reference);
    }
    return { operation: "videos/frames", body };
  }

  return {
    operation: "videos",
    body: JSON.stringify({
      prompt,
      durationSeconds,
      resolution,
      aspectRatio,
      generateAudio,
      ...(model ? { model } : {}),
      ...(suppliedSeed === null ? {} : { seed: suppliedSeed }),
    }),
  };
}

/** Upload a source clip. Edits follow its length; extensions name the added length. */
export function buildAiSourceVideoSubmission({
  mode, prompt, source, durationSeconds, model,
}: {
  mode: "edit" | "extend";
  prompt: string;
  source: File;
  durationSeconds: number | null;
  model: string;
}): AiVideoSubmission {
  const body = new FormData();
  body.set("prompt", prompt);
  body.set("sourceVideo", source);
  if (mode === "extend" && durationSeconds !== null) body.set("durationSeconds", String(durationSeconds));
  if (model) body.set("model", model);
  return { operation: mode === "edit" ? "videos/edit" : "videos/extend", body };
}

/** Upload the motion source together with the character image. */
export function buildAiMotionVideoSubmission({
  prompt, source, characterImage, durationSeconds, orientation, quality, model,
}: {
  prompt: string;
  source: File;
  characterImage: File;
  durationSeconds: number;
  orientation: "image" | "video";
  quality: "standard" | "pro";
  model: string;
}): AiVideoSubmission {
  const body = new FormData();
  body.set("prompt", prompt);
  body.set("sourceVideo", source);
  body.set("characterImage", characterImage);
  body.set("durationSeconds", String(durationSeconds));
  body.set("orientation", orientation);
  body.set("quality", quality);
  if (model) body.set("model", model);
  return { operation: "videos/motion", body };
}
