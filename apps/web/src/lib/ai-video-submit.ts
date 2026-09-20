import { MAX_AI_VIDEO_FRAME_UPLOAD_BYTES, MAX_AI_VIDEO_INPUT_VIDEOS_TOTAL_BYTES, MAX_AI_VIDEO_INPUT_AUDIO_BYTES } from "@beutl/core";

/** The hash must cover every byte the reference upload can send. */
export function videoReferenceFingerprintLimit(file: File): number {
  const type = file.type.split(";", 1)[0]!.trim().toLowerCase();
  if (type === "video/mp4" || type === "video/webm") return MAX_AI_VIDEO_INPUT_VIDEOS_TOTAL_BYTES;
  if (["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3"].includes(type)) return MAX_AI_VIDEO_INPUT_AUDIO_BYTES;
  return MAX_AI_VIDEO_FRAME_UPLOAD_BYTES;
}

import { seedValue } from "./ai-screen";

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

/**
 * An edit or an extension of a video this account already has.
 *
 * The source is named by the job that produced it rather than uploaded: the
 * bytes are already here, so nothing is sent twice and the API can check who
 * owns it before anything is charged.
 *
 * An edit produces something as long as its source, so it carries no length —
 * sending one would be a number nothing honours, and the API refuses it.
 */
export function buildAiSourceVideoSubmission({
  mode,
  prompt,
  source,
  durationSeconds,
  model,
}: {
  mode: "edit" | "extend";
  prompt: string;
  // Either a finished job of this account's, or a video chosen from disk. The
  // API tells the two apart by the content type, so the shape follows.
  source: { kind: "job"; jobId: string } | { kind: "file"; file: File };
  // The added segment's length, for an extension only.
  durationSeconds: number | null;
  model: string;
}): AiVideoSubmission {
  const operation = mode === "edit" ? "videos/edit" : "videos/extend";
  const sendsDuration = mode === "extend" && durationSeconds !== null;

  if (source.kind === "file") {
    const body = new FormData();
    body.set("prompt", prompt);
    body.set("sourceVideo", source.file);
    if (sendsDuration) body.set("durationSeconds", String(durationSeconds));
    if (model) body.set("model", model);
    return { operation, body };
  }

  return {
    operation,
    body: JSON.stringify({
      prompt,
      sourceJobId: source.jobId,
      ...(sendsDuration ? { durationSeconds } : {}),
      ...(model ? { model } : {}),
    }),
  };
}

/**
 * A character picture given the motion of a video this account already has.
 *
 * Multipart because this is the one mode that also carries an upload: the
 * character is a picture, while the motion comes from a finished job named the
 * same way an edit names its source.
 */
export function buildAiMotionVideoSubmission({
  prompt,
  source,
  characterImage,
  durationSeconds,
  orientation,
  quality,
  model,
}: {
  prompt: string;
  source: { kind: "job"; jobId: string } | { kind: "file"; file: File };
  characterImage: File;
  durationSeconds: number;
  // Whether the result follows the character picture's shape or the reference
  // video's.
  orientation: "image" | "video";
  quality: "standard" | "pro";
  model: string;
}): AiVideoSubmission {
  const body = new FormData();
  body.set("prompt", prompt);
  // Exactly one of the two. The API refuses a request naming both, because
  // which of them was paid for would otherwise depend on which branch ran.
  if (source.kind === "file") body.set("sourceVideo", source.file);
  else body.set("sourceJobId", source.jobId);
  body.set("characterImage", characterImage);
  body.set("durationSeconds", String(durationSeconds));
  body.set("orientation", orientation);
  body.set("quality", quality);
  if (model) body.set("model", model);
  return { operation: "videos/motion", body };
}
