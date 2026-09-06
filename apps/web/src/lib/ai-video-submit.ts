import { seedValue } from "./ai-screen";

export type AiVideoSubmission = {
  operation: "videos" | "videos/frames";
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
}): AiVideoSubmission {
  const trimmedSeed = seedText.trim();
  const normalizedSeed = seedEnabled ? seedValue(seedText) : null;
  const suppliedSeed = seedEnabled && trimmedSeed !== ""
    ? normalizedSeed ?? seedText
    : null;

  if (firstFrame) {
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
    body.set("firstFrame", firstFrame);
    if (lastFrame) body.set("lastFrame", lastFrame);
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
