"use server";

import { throwIfUnauth } from "@/lib/auth-guard";
import { getLanguage } from "@beutl/next/language";
import { getTranslation } from "@beutl/i18n";
import { headers } from "next/headers";
import {
  AI_JOB_FAILURE_MESSAGES,
  AiProviderError,
  MAX_AI_IMAGE_UPLOAD_BYTES,
  MAX_AI_PROMPT_LENGTH,
  MAX_AI_TRANSCRIPTION_UPLOAD_BYTES,
  MAX_AI_VIDEO_FRAME_UPLOAD_BYTES,
  createCallbackNonce,
  createReservedAiJob,
  decodeGeneratedImageBase64,
  editImage,
  failAiJobAndRefundUsage,
  generateImage,
  inspectGeneratedImage,
  isIso6391LanguageCode,
  loadAiModelCatalog,
  parseAudio,
  readAiJsonResult,
  saveAiImage,
  saveAiJsonResult,
  sha256Hex,
  MAX_TRANSLATION_CHARACTERS,
  MAX_TRANSLATION_SEGMENTS,
  SAFE_SEGMENT_ID_PATTERN,
  synchronizeAiVideoJob,
  toAiRequestIdentity,
  transcribeAudio,
  translateSegments,
  translationCharacterCount,
  validateAiInputImage,
  type TranslationStyle,
  validateTranscriptionResult,
  type AiInputImageMimeType,
  type ImageEditTask,
} from "@beutl/api";
import {
  finalizeAiJobDeletionByUserId,
  getAiJobById,
  getAiJobResultFile,
  listAiJobsByUserId,
  prepareAiJobDeletionByUserId,
} from "@beutl/db";
import {
  classifyVideoSubmissionFailure,
  createAndAttachVideoJob,
  deleteAiOutputObject,
  loadAiImageModelCapabilities,
  loadAiVideoModelCapabilities,
  unsupportedImageRequestReason,
  unsupportedVideoRequestReason,
} from "@beutl/api";
import {
  AI_IMAGE_ASPECT_RATIOS,
  AI_MAX_IMAGE_REFERENCES,
  AI_IMAGE_BACKGROUNDS,
  AI_IMAGE_EDIT_TASKS,
  AI_VIDEO_ASPECT_RATIOS,
  AI_VIDEO_RESOLUTIONS,
  aiImageEditTaskRequiresPrompt,
  aspectRatioOfLegacyImageSize,
  isAiSeed,
  isAiVideoDurationSeconds,
  type AiImageAspectRatio,
  type AiImageBackground,
  type AiVideoAspectRatio,
  type AiVideoResolution,
} from "@beutl/core";
import { composePrompt } from "@/lib/ai-prompt";
import { parseGlossary } from "@/lib/subtitle-format";
import { getContentUrl } from "@/lib/content-url";

export type AiActionResult = {
  success: boolean;
  message?: string;
  jobId?: string;
  status?: string;
  url?: string | null;
  fileName?: string | null;
  contentType?: string | null;
  segments?: unknown;
  // Word timings and the detected language come back from the provider and are
  // stored with the transcript; the editor uses them to cut a cue at a word
  // rather than at the midpoint of its duration.
  words?: unknown;
  language?: string;
  jobs?: unknown[];
  nextCursor?: { createdAt: string; id: string } | null;
};

const supportedEditImageTypes = new Set<AiInputImageMimeType>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const supportedFrameImageTypes = new Set<AiInputImageMimeType>([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

// The form sends a key that stays the same across every arrival of one
// submission, so a double click or a retried POST lands on the job the first
// arrival created instead of reserving and charging again. A missing or
// malformed key means the request cannot be made safely repeatable, so it is
// refused rather than charged — the v3 endpoints answer a missing
// Idempotency-Key header the same way.
async function requestIdentityOf(
  formData: FormData,
  operation: string,
  input: unknown,
) {
  return await toAiRequestIdentity({
    idempotencyKey: formData.get("idempotencyKey"),
    operation,
    input,
  });
}

// The model the user picked, resolved against the catalog. An id that is
// unknown or has been disabled is refused rather than quietly replaced by the
// default: the default may cost more than the one they chose, and they would
// be charged that price for a model they never asked for.
async function resolveModelOf(formData: FormData, operation: string) {
  const requested = formData.get("model");
  if (requested !== null && typeof requested !== "string") return null;
  const catalog = await loadAiModelCatalog();
  return catalog.resolve(operation, requested);
}

// Submitting a video is the one AI operation whose failure is not simply a
// refund: OpenRouter may have accepted a job we lost track of. The shared
// classifier decides, so this path and the v3 endpoints cannot drift apart.
async function handleVideoSubmissionFailure({
  userId,
  jobId,
  error,
  t,
}: {
  userId: string;
  jobId: string;
  error: unknown;
  t: (key: string) => string;
}): Promise<AiActionResult> {
  const handling = classifyVideoSubmissionFailure(error);
  if (handling.action === "refund") {
    await failAiJobAndRefundUsage({
      userId,
      aiJobId: jobId,
      error: AI_JOB_FAILURE_MESSAGES.videoSubmission,
      ...(handling.detachProviderJob ? { expectedProviderJobId: null } : {}),
    });
    return { success: false, message: t("api-errors:aiProviderError") };
  }
  if (handling.action === "keepQueued") {
    // The provider may still call back, so the job stays queued rather than
    // being refunded out from under a submission that was accepted.
    console.error(
      `OpenRouter video submission outcome is unknown for AI job ${jobId}`,
      error,
    );
    return { success: true, jobId };
  }
  throw error;
}

// A repeated submission has to answer with the result the first one produced,
// not merely with "already done". Both recoveries re-read the stored JSON and
// re-validate it, exactly as the v3 endpoints do, so a corrupted or truncated
// object fails loudly instead of rendering as an empty editor.
async function recoverTranscription({
  jobId,
  userId,
  durationSeconds,
}: {
  jobId: string;
  userId: string;
  durationSeconds: number;
}): Promise<{ segments: unknown; language?: string; words?: unknown } | null> {
  const fileRecord = await getAiJobResultFile({ jobId, userId });
  if (!fileRecord) return null;
  try {
    const stored = validateTranscriptionResult(
      (await readAiJsonResult({ objectKey: fileRecord.objectKey })) as {
        segments?: unknown;
        language?: unknown;
        words?: unknown;
      },
      durationSeconds,
    );
    return {
      segments: stored.segments,
      ...(stored.language ? { language: stored.language } : {}),
      ...(stored.words ? { words: stored.words } : {}),
    };
  } catch (error) {
    console.error("Failed to recover AI transcription result", error);
    return null;
  }
}

async function recoverTranslation({
  jobId,
  userId,
  segments,
}: {
  jobId: string;
  userId: string;
  segments: { id: string; text: string }[];
}): Promise<{ id: string; text: string }[] | null> {
  const fileRecord = await getAiJobResultFile({ jobId, userId });
  if (!fileRecord) return null;
  try {
    const stored = (await readAiJsonResult({
      objectKey: fileRecord.objectKey,
    })) as { segments?: unknown };
    if (!Array.isArray(stored.segments)) return null;
    const translatedById = new Map<string, string>();
    for (const entry of stored.segments) {
      if (entry === null || typeof entry !== "object") return null;
      const record = entry as { id?: unknown; text?: unknown };
      if (typeof record.id !== "string" || typeof record.text !== "string") {
        return null;
      }
      translatedById.set(record.id, record.text);
    }
    // The stored result belongs to this request only when it covers exactly the
    // segments being asked for again.
    if (
      translatedById.size !== segments.length ||
      !segments.every((segment) => translatedById.has(segment.id))
    ) {
      return null;
    }
    return segments.map((segment) => ({
      id: segment.id,
      text: translatedById.get(segment.id) as string,
    }));
  } catch (error) {
    console.error("Failed to recover AI translation result", error);
    return null;
  }
}

// Only an operation whose whole input was recorded can be repeated. A prompt is
// recorded; an uploaded image is not — neither the source of an edit nor the
// frames a video was conditioned on — so those would rerun as something else at
// full price.
function canRetryJob(job: {
  kind: string;
  status: string;
  inputParams: unknown;
}): boolean {
  if (job.status !== "failed" && job.status !== "succeeded") return false;
  if (job.kind !== "image" && job.kind !== "video") return false;
  if (job.inputParams === null || typeof job.inputParams !== "object") {
    return false;
  }
  const input = job.inputParams as Record<string, unknown>;
  if (typeof input.prompt !== "string") return false;
  if (job.kind === "image") {
    if (input.reference || input.references) return false;
    // retryJobAction refuses a generation that recorded no shape, so offering
    // the button for one only produces an error the user cannot act on.
    return (
      typeof input.aspectRatio === "string" || typeof input.size === "string"
    );
  }
  if (job.kind === "video" && (input.firstFrame || input.lastFrame)) {
    return false;
  }
  return true;
}

// The cue timings the translate screen already holds, keyed by segment id.
// Anything that does not line up with the segments being sent is dropped rather
// than guessed at.
function readTranslationContexts(
  value: FormDataEntryValue | null,
  ids: string[],
): Record<string, { start: number; end: number }> {
  if (typeof value !== "string" || value.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object") return {};
  const known = new Set(ids);
  const contexts: Record<string, { start: number; end: number }> = {};
  for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (!known.has(id) || entry === null || typeof entry !== "object") continue;
    const record = entry as { start?: unknown; end?: unknown };
    if (
      typeof record.start !== "number" ||
      typeof record.end !== "number" ||
      !Number.isFinite(record.start) ||
      !Number.isFinite(record.end) ||
      record.end <= record.start
    ) {
      continue;
    }
    contexts[id] = { start: record.start, end: record.end };
  }
  return contexts;
}

function readTranslationStyle(formData: FormData): TranslationStyle | undefined {
  const glossary = parseGlossary(String(formData.get("glossary") ?? ""));
  const maxCharactersPerLine = Number(
    String(formData.get("maxCharactersPerLine") ?? "").trim(),
  );
  const maxLines = Number(String(formData.get("maxLines") ?? "").trim());
  const style: TranslationStyle = {
    ...(Object.keys(glossary).length > 0 ? { glossary } : {}),
    ...(Number.isSafeInteger(maxCharactersPerLine) &&
    maxCharactersPerLine >= 1 &&
    maxCharactersPerLine <= 200
      ? { maxCharactersPerLine }
      : {}),
    ...(Number.isSafeInteger(maxLines) && maxLines >= 1 && maxLines <= 10
      ? { maxLines }
      : {}),
  };
  return Object.keys(style).length > 0 ? style : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof AiProviderError) {
    return "aiProviderError";
  }
  console.error("AI action failed", error);
  return "unknown";
}

async function resolveOrigin(): Promise<string> {
  const fromEnv = process.env.PUBLIC_ORIGIN;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const url = (await headers()).get("x-url");
  if (url) return new URL(url).origin;
  return "";
}

// OpenRouter only calls back over HTTPS, so a server reachable only over plain
// HTTP — a local one, typically — gets no callback URL at all and its jobs are
// finished by the poll path instead. Sending the URL anyway fails the whole
// submission, which made video generation impossible to run locally.
async function resolveVideoCallbackUrl(
  jobId: string,
  nonce: string,
): Promise<string | undefined> {
  const origin = await resolveOrigin();
  let callbackUrl: URL;
  try {
    callbackUrl = new URL(
      `/api/v3/ai/videos/${encodeURIComponent(jobId)}/openrouter-callback`,
      origin,
    );
  } catch {
    return undefined;
  }
  if (callbackUrl.protocol !== "https:") return undefined;
  callbackUrl.searchParams.set("nonce", nonce);
  return callbackUrl.toString();
}

export async function generateImageAction(
  _state: AiActionResult,
  formData: FormData,
): Promise<AiActionResult> {
  const session = await throwIfUnauth();
  const lang = await getLanguage();
  const { t } = await getTranslation(lang);
  const prompt = composePrompt({
    main: String(formData.get("prompt") ?? "").trim(),
    style: String(formData.get("style") ?? "").trim() || undefined,
    composition: String(formData.get("composition") ?? "").trim() || undefined,
    exclusions: String(formData.get("exclusions") ?? "").trim() || undefined,
  });
  const aspectRatio = String(
    formData.get("aspectRatio") ?? "1:1",
  ) as AiImageAspectRatio;
  const background = String(
    formData.get("background") ?? "auto",
  ) as AiImageBackground;
  const seedField = String(formData.get("seed") ?? "").trim();
  const seed = seedField === "" ? undefined : Number(seedField);
  if (!prompt || prompt.length > MAX_AI_PROMPT_LENGTH) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }
  if (!AI_IMAGE_ASPECT_RATIOS.includes(aspectRatio)) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }
  if (!AI_IMAGE_BACKGROUNDS.includes(background)) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }
  if (seed !== undefined && !isAiSeed(seed)) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }

  // The pictures a generation is guided by. How many a model takes differs, and
  // the price is set for AI_MAX_IMAGE_REFERENCES of them.
  const referenceFiles = formData
    .getAll("reference")
    .filter((value): value is File => value instanceof File && value.size > 0);
  if (referenceFiles.length > AI_MAX_IMAGE_REFERENCES) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }
  // Size first: validateAiInputImage buffers the whole upload, so checking
  // afterwards lets an oversized body be materialized before it is refused.
  if (referenceFiles.some((file) => file.size > MAX_AI_IMAGE_UPLOAD_BYTES)) {
    return { success: false, message: t("api-errors:fileIsTooLarge") };
  }
  const validated = await Promise.all(
    referenceFiles.map((file) =>
      validateAiInputImage(file, supportedEditImageTypes),
    ),
  );
  const references = validated.filter(
    (reference): reference is NonNullable<typeof reference> =>
      reference !== null,
  );
  if (references.length !== referenceFiles.length) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }

  const selectedModel = await resolveModelOf(formData, "image.generate");
  if (!selectedModel) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }

  // Checked before the reservation: GPT Image-1 renders 1:1, 3:2 and 2:3 and
  // GPT Image-2 cuts out no background, and a rejection that arrives after the
  // usage is reserved reads as a provider outage.
  if (
    unsupportedImageRequestReason(
      (await loadAiImageModelCapabilities([selectedModel.modelId])).get(
        selectedModel.modelId,
      ),
      {
        aspectRatio,
        background,
        ...(seed === undefined ? {} : { seed }),
        referenceImages: references.length,
      },
    )
  ) {
    return {
      success: false,
      message: t("api-errors:aiModelDoesNotSupportRequest"),
    };
  }

  const identity = await requestIdentityOf(formData, "image.generate", {
    model: selectedModel.modelId,
    prompt,
    aspectRatio,
    ...(background !== "auto" ? { background } : {}),
    ...(seed === undefined ? {} : { seed }),
    // Every picture is part of what makes this request the request it is: the
    // same prompt guided by different pictures is a different run.
    ...(references.length > 0
      ? {
          references: await Promise.all(
            references.map(async (reference, index) => ({
              fileName: referenceFiles[index]!.name,
              contentType: reference.mimeType,
              contentSha256: await sha256Hex(reference.bytes),
            })),
          ),
        }
      : {}),
  });
  if (!identity) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }

  const cost = selectedModel.priceUnits;
  const reservation = await createReservedAiJob({
    userId: session.user.id,
    kind: "image",
    provider: "openrouter",
    status: "running",
    inputParams: {
      prompt,
      aspectRatio,
      ...(background !== "auto" ? { background } : {}),
      ...(seed === undefined ? {} : { seed }),
      ...(referenceFiles.length > 0
        ? {
            references: referenceFiles.map((file) => ({ filename: file.name })),
          }
        : {}),
    },
    usageUnits: cost,
    model: selectedModel.modelId,
    ...identity,
  });
  if (!reservation.ok) {
    return { success: false, message: t(`api-errors:${reservation.errorCode}`) };
  }
  const { job } = reservation;
  if (reservation.outcome === "existing") {
    if (job.status === "succeeded" && job.resultFileId) {
      return {
        success: true,
        jobId: job.id,
        url: await getContentUrl(job.resultFileId),
        fileName: "resultFile" in job ? job.resultFile?.name ?? null : null,
        contentType: "resultFile" in job ? job.resultFile?.mimeType ?? null : null,
      };
    }
    return { success: false, message: t("api-errors:aiRequestInProgress") };
  }

  try {
    const result = await generateImage({
      prompt,
      aspectRatio,
      ...(background !== "auto" ? { background } : {}),
      ...(references.length > 0
        ? {
            referenceImages: references.map((reference) => ({
              bytes: reference.bytes,
              mimeType: reference.mimeType,
            })),
          }
        : {}),
      ...(seed === undefined ? {} : { seed }),
      model: selectedModel.modelId,
    });
    const bytes = decodeGeneratedImageBase64(result.b64Json);
    await inspectGeneratedImage(bytes, result.mediaType);
    const file = await saveAiImage({
      jobId: job.id,
      userId: session.user.id,
      bytes,
      mimeType: "image/png",
      filename: `ai-image-${job.id}.png`,
    });
    return {
      success: true,
      jobId: job.id,
      url: await getContentUrl(file.id),
      fileName: file.name,
      contentType: file.mimeType,
    };
  } catch (error) {
    await failAiJobAndRefundUsage({
      userId: session.user.id,
      aiJobId: job.id,
      error: AI_JOB_FAILURE_MESSAGES.imageGeneration,
    });
    return { success: false, message: t(`api-errors:${errorMessage(error)}`) };
  }
}

export async function editImageAction(
  _state: AiActionResult,
  formData: FormData,
): Promise<AiActionResult> {
  const session = await throwIfUnauth();
  const lang = await getLanguage();
  const { t } = await getTranslation(lang);
  const task = String(formData.get("task") ?? "") as ImageEditTask;
  const prompt = String(formData.get("prompt") ?? "").trim();
  const outpaintExpansion = Number(formData.get("outpaintExpansion") ?? 25);
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0 || file.size > MAX_AI_IMAGE_UPLOAD_BYTES) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }
  if (!(AI_IMAGE_EDIT_TASKS as readonly string[]).includes(task)) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }
  if (aiImageEditTaskRequiresPrompt(task) && !prompt) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }
  if (prompt.length > MAX_AI_PROMPT_LENGTH) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }
  if (task === "outpaint" && ![10, 25, 50].includes(outpaintExpansion)) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }
  const validated = await validateAiInputImage(file, supportedEditImageTypes);
  if (!validated) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }

  const selectedModel = await resolveModelOf(formData, `image.edit.${task}`);
  if (!selectedModel) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }
  const cost = selectedModel.priceUnits;
  // editImage substitutes its own prompt for the tasks that do not take one, so
  // carrying the user's text for those would record and fingerprint a string
  // the provider never sees. The v3 endpoint drops it for the same reason.
  const editPrompt = !aiImageEditTaskRequiresPrompt(task)
    ? undefined
    : task === "outpaint"
      ? `Extend the image naturally into the transparent canvas while preserving the original center. ${prompt}`
      : prompt;
  // An edit hands the model a picture, cuts out a background or asks for a
  // size; a model that takes none of those is refused before it is paid for.
  if (
    unsupportedImageRequestReason(
      (await loadAiImageModelCapabilities([selectedModel.modelId])).get(
        selectedModel.modelId,
      ),
      {
        // The picture being edited.
        referenceImages: 1,
        // Removing a background is asking for a transparent one.
        ...(task === "remove_background"
          ? { background: "transparent" as const }
          : {}),
        resolution: task === "upscale",
      },
    )
  ) {
    return {
      success: false,
      message: t("api-errors:aiModelDoesNotSupportRequest"),
    };
  }

  const identity = await requestIdentityOf(formData, `image.edit.${task}`, {
    model: selectedModel.modelId,
    task,
    ...(editPrompt ? { prompt: editPrompt } : {}),
    fileName: file.name,
    contentType: validated.mimeType,
    contentSha256: await sha256Hex(validated.bytes),
  });
  if (!identity) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }
  const reservation = await createReservedAiJob({
    userId: session.user.id,
    // The same kind the v3 edit endpoint writes. Tagging an edit as "image"
    // makes it indistinguishable from a generation, and the retry path then
    // reruns it as text-to-image: no source picture, and the generation price.
    kind: "image_edit",
    provider: "openrouter",
    status: "running",
    inputParams: {
      task,
      filename: file.name,
      ...(editPrompt ? { prompt: editPrompt } : {}),
      ...(task === "outpaint" ? { outpaintExpansion } : {}),
    },
    usageUnits: cost,
    model: selectedModel.modelId,
    ...identity,
  });
  if (!reservation.ok) {
    return { success: false, message: t(`api-errors:${reservation.errorCode}`) };
  }
  const { job } = reservation;
  if (reservation.outcome === "existing") {
    if (job.status === "succeeded" && job.resultFileId) {
      return {
        success: true,
        jobId: job.id,
        url: await getContentUrl(job.resultFileId),
        fileName: "resultFile" in job ? job.resultFile?.name ?? null : null,
        contentType: "resultFile" in job ? job.resultFile?.mimeType ?? null : null,
      };
    }
    return { success: false, message: t("api-errors:aiRequestInProgress") };
  }

  try {
    const result = await editImage({
      task,
      image: validated.bytes,
      mimeType: validated.mimeType,
      ...(editPrompt ? { prompt: editPrompt } : {}),
      model: selectedModel.modelId,
    });
    const bytes = decodeGeneratedImageBase64(result.b64Json);
    await inspectGeneratedImage(bytes, result.mediaType);
    const saved = await saveAiImage({
      jobId: job.id,
      userId: session.user.id,
      bytes,
      mimeType: "image/png",
      filename: `ai-edit-${job.id}.png`,
    });
    return {
      success: true,
      jobId: job.id,
      url: await getContentUrl(saved.id),
      fileName: saved.name,
      contentType: saved.mimeType,
    };
  } catch (error) {
    await failAiJobAndRefundUsage({
      userId: session.user.id,
      aiJobId: job.id,
      error: AI_JOB_FAILURE_MESSAGES.imageEdit,
    });
    return { success: false, message: t(`api-errors:${errorMessage(error)}`) };
  }
}

export async function transcribeAction(
  _state: AiActionResult,
  formData: FormData,
): Promise<AiActionResult> {
  const session = await throwIfUnauth();
  const lang = await getLanguage();
  const { t } = await getTranslation(lang);
  const file = formData.get("file");
  const language =
    String(formData.get("language") ?? "").trim().toLowerCase() || undefined;
  if (!(file instanceof File) || file.size === 0 || file.size > MAX_AI_TRANSCRIPTION_UPLOAD_BYTES) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }
  // The value reaches the provider prompt and is stored on the job, so it is
  // held to the same ISO 639-1 allowlist the v3 endpoint applies.
  if (language !== undefined && !isIso6391LanguageCode(language)) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }

  let parsedAudio;
  try {
    parsedAudio = await parseAudio(file);
  } catch {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }
  const minutes = Math.max(1, Math.ceil(parsedAudio.durationSeconds / 60));
  const selectedModel = await resolveModelOf(formData, "audio.transcribe");
  if (!selectedModel) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }
  const identity = await requestIdentityOf(formData, "audio.transcribe", {
    model: selectedModel.modelId,
    fileName: file.name,
    contentType: file.type || "audio/mpeg",
    durationSeconds: parsedAudio.durationSeconds,
    contentSha256: await sha256Hex(parsedAudio.bytes),
    ...(language ? { language } : {}),
  });
  if (!identity) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }
  const cost = selectedModel.priceUnits * minutes;
  const reservation = await createReservedAiJob({
    userId: session.user.id,
    kind: "stt",
    provider: "openrouter",
    status: "running",
    inputParams: {
      filename: file.name,
      durationSeconds: parsedAudio.durationSeconds,
      ...(language ? { language } : {}),
    },
    usageUnits: cost,
    model: selectedModel.modelId,
    ...identity,
  });
  if (!reservation.ok) {
    return { success: false, message: t(`api-errors:${reservation.errorCode}`) };
  }
  const { job } = reservation;
  if (reservation.outcome === "existing") {
    // The same submission arriving twice must show the result the first one
    // paid for. Returning only a URL left the screen blank, because the editor
    // renders segments and never reads a URL.
    if (job.status === "succeeded" && job.resultFileId) {
      const recovered = await recoverTranscription({
        jobId: job.id,
        userId: session.user.id,
        durationSeconds: parsedAudio.durationSeconds,
      });
      if (recovered) {
        return { success: true, jobId: job.id, ...recovered };
      }
      return { success: false, message: t("api-errors:aiProviderError") };
    }
    return { success: false, message: t("api-errors:aiRequestInProgress") };
  }

  try {
    const result = await transcribeAudio({
      audio: parsedAudio.bytes,
      durationSeconds: parsedAudio.durationSeconds,
      filename: file.name,
      mimeType: file.type || "audio/mpeg",
      ...(language ? { language } : {}),
      model: selectedModel.modelId,
    });
    await saveAiJsonResult({
      jobId: job.id,
      userId: session.user.id,
      filename: `transcription-${job.id}.json`,
      result: {
        version: 1,
        kind: "stt",
        segments: result.segments,
        ...(result.language ? { language: result.language } : {}),
        ...(result.words ? { words: result.words } : {}),
      },
    });
    return {
      success: true,
      jobId: job.id,
      segments: result.segments,
      ...(result.language ? { language: result.language } : {}),
      ...(result.words ? { words: result.words } : {}),
    };
  } catch (error) {
    await failAiJobAndRefundUsage({
      userId: session.user.id,
      aiJobId: job.id,
      error: AI_JOB_FAILURE_MESSAGES.transcription,
    });
    return { success: false, message: t(`api-errors:${errorMessage(error)}`) };
  }
}

export async function translateAction(
  _state: AiActionResult,
  formData: FormData,
): Promise<AiActionResult> {
  const session = await throwIfUnauth();
  const lang = await getLanguage();
  const { t } = await getTranslation(lang);
  const targetLanguage = String(formData.get("targetLanguage") ?? "").trim().toLowerCase();
  const sourceLanguage = String(formData.get("sourceLanguage") ?? "").trim().toLowerCase() || undefined;
  const segmentsText = String(formData.get("segments") ?? "").trim();
  if (!segmentsText || !isIso6391LanguageCode(targetLanguage)) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }
  if (sourceLanguage !== undefined && !isIso6391LanguageCode(sourceLanguage)) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }
  let segments: { id: string; text: string }[];
  try {
    const parsed = JSON.parse(segmentsText) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      parsed.length > MAX_TRANSLATION_SEGMENTS
    ) {
      return { success: false, message: t("api-errors:invalidRequestBody") };
    }
    // A repeated ID cannot be answered: the provider returns one translation
    // per ID, so the reply can never cover the input. Rejecting it here rather
    // than at the response keeps a request that could not have succeeded from
    // being reserved, charged, and paid for at the provider. The v3 endpoint
    // rejects the same body with 400.
    const seenIds = new Set<string>();
    segments = parsed.map((item) => {
      const record = item as { id?: unknown; text?: unknown };
      if (
        typeof record.id !== "string" ||
        !SAFE_SEGMENT_ID_PATTERN.test(record.id) ||
        seenIds.has(record.id) ||
        typeof record.text !== "string" ||
        record.text.trim().length === 0
      ) {
        throw new Error("invalid segment");
      }
      seenIds.add(record.id);
      return { id: record.id, text: record.text };
    });
  } catch {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }
  // Timings from the source the user pasted. A translated line that does not
  // fit its cue is unreadable no matter how good the wording is.
  const contexts = readTranslationContexts(
    formData.get("contexts"),
    segments.map((segment) => segment.id),
  );
  const style = readTranslationStyle(formData);
  // The glossary is sent to the provider and paid for there, so it counts
  // against the same budget and the same charge as the segments.
  const characterCount = translationCharacterCount({ segments, style });
  if (characterCount > MAX_TRANSLATION_CHARACTERS) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }

  const selectedModel = await resolveModelOf(formData, "subtitle.translate");
  if (!selectedModel) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }
  const identity = await requestIdentityOf(formData, "subtitle.translate", {
    model: selectedModel.modelId,
    ...(sourceLanguage ? { sourceLanguage } : {}),
    targetLanguage,
    segments,
    ...(Object.keys(contexts).length > 0 ? { contexts } : {}),
    ...(style ? { style } : {}),
  });
  if (!identity) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }

  const usageUnits =
    selectedModel.priceUnits *
    Math.max(1, Math.ceil(characterCount / 1_000));
  const reservation = await createReservedAiJob({
    userId: session.user.id,
    kind: "translation",
    provider: "openrouter",
    status: "running",
    inputParams: {
      ...(sourceLanguage ? { sourceLanguage } : {}),
      targetLanguage,
      segmentCount: segments.length,
      characterCount,
    },
    usageUnits,
    model: selectedModel.modelId,
    ...identity,
  });
  if (!reservation.ok) {
    return { success: false, message: t(`api-errors:${reservation.errorCode}`) };
  }
  const { job } = reservation;
  if (reservation.outcome === "existing") {
    if (job.status === "succeeded" && job.resultFileId) {
      const recovered = await recoverTranslation({
        jobId: job.id,
        userId: session.user.id,
        segments,
      });
      if (recovered) {
        return { success: true, jobId: job.id, segments: recovered };
      }
      return { success: false, message: t("api-errors:aiProviderError") };
    }
    return { success: false, message: t("api-errors:aiRequestInProgress") };
  }

  try {
    const translated = await translateSegments({
      ...(sourceLanguage ? { sourceLanguage } : {}),
      targetLanguage,
      segments,
      ...(Object.keys(contexts).length > 0 ? { contexts } : {}),
      ...(style ? { style } : {}),
      model: selectedModel.modelId,
    });
    await saveAiJsonResult({
      jobId: job.id,
      userId: session.user.id,
      filename: `translation-${job.id}.json`,
      result: {
        version: 1,
        kind: "translation",
        ...(sourceLanguage ? { sourceLanguage } : {}),
        targetLanguage,
        // Without the timing a stored translation can only be recovered as
        // text, so the history cannot re-export it as a subtitle file.
        segments: translated.map((segment) => {
          const context = contexts[segment.id];
          return context ? { ...segment, context } : segment;
        }),
      },
    });
    return { success: true, jobId: job.id, segments: translated };
  } catch (error) {
    await failAiJobAndRefundUsage({
      userId: session.user.id,
      aiJobId: job.id,
      error: AI_JOB_FAILURE_MESSAGES.translation,
    });
    return { success: false, message: t(`api-errors:${errorMessage(error)}`) };
  }
}

export async function createVideoAction(
  _state: AiActionResult,
  formData: FormData,
): Promise<AiActionResult> {
  const session = await throwIfUnauth();
  const lang = await getLanguage();
  const { t } = await getTranslation(lang);
  const prompt = composePrompt({
    main: String(formData.get("prompt") ?? "").trim(),
    style: String(formData.get("style") ?? "").trim() || undefined,
    composition: String(formData.get("composition") ?? "").trim() || undefined,
    motion: String(formData.get("motion") ?? "").trim() || undefined,
    exclusions: String(formData.get("exclusions") ?? "").trim() || undefined,
  });
  const durationSeconds = Number(formData.get("durationSeconds") ?? 4);
  const resolution = String(
    formData.get("resolution") ?? "720p",
  ) as AiVideoResolution;
  const videoAspectRatio = String(
    formData.get("aspectRatio") ?? "16:9",
  ) as AiVideoAspectRatio;
  // Audio on by default: that is what the provider has effectively been
  // producing, and what the cost estimate assumes is being paid for.
  const generateAudio = String(formData.get("generateAudio") ?? "true") !== "false";
  const videoSeedField = String(formData.get("seed") ?? "").trim();
  const videoSeed =
    videoSeedField === "" ? undefined : Number(videoSeedField);
  if (!prompt || prompt.length > MAX_AI_PROMPT_LENGTH) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }
  if (!isAiVideoDurationSeconds(durationSeconds)) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }
  if (!AI_VIDEO_RESOLUTIONS.includes(resolution)) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }
  if (!AI_VIDEO_ASPECT_RATIOS.includes(videoAspectRatio)) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }
  if (videoSeed !== undefined && !isAiSeed(videoSeed)) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }

  const firstFrame = formData.get("firstFrame");
  const lastFrame = formData.get("lastFrame");
  const frameImages: Array<{
    type: "image_url";
    image_url: { url: string };
    frame_type: "first_frame" | "last_frame";
  }> = [];
  // Two runs of the same prompt with different start frames are different
  // requests, so the frames belong in the fingerprint.
  const frameDigests: Record<string, { contentType: string; sha256: string }> =
    {};
  // Recorded so the history can tell a frame-conditioned video apart from a
  // text-to-video one. The images themselves are not kept, which is why such a
  // job cannot be rerun.
  const frameParams: Record<string, { filename: string; mimeType: string }> = {};
  for (const [frame, frameType] of [
    [firstFrame, "first_frame"],
    [lastFrame, "last_frame"],
  ] as const) {
    if (frame instanceof File && frame.size > 0) {
      if (frame.size > MAX_AI_VIDEO_FRAME_UPLOAD_BYTES) {
        return { success: false, message: t("api-errors:fileIsTooLarge") };
      }
      const validated = await validateAiInputImage(frame, supportedFrameImageTypes);
      if (!validated) {
        return { success: false, message: t("api-errors:invalidRequestBody") };
      }
      const bytes = new Uint8Array(validated.bytes);
      let binary = "";
      const chunkSize = 0x8000;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(
          ...bytes.subarray(offset, offset + chunkSize),
        );
      }
      frameImages.push({
        type: "image_url",
        image_url: {
          url: `data:${validated.mimeType};base64,${btoa(binary)}`,
        },
        frame_type: frameType,
      });
      frameDigests[frameType] = {
        contentType: validated.mimeType,
        sha256: await sha256Hex(validated.bytes),
      };
      frameParams[frameType === "first_frame" ? "firstFrame" : "lastFrame"] = {
        filename: frame.name,
        mimeType: validated.mimeType,
      };
    }
  }

  const selectedModel = await resolveModelOf(formData, "video.generate");
  if (!selectedModel) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }

  // Checked before the reservation: a model that cannot render this
  // combination is refused by the provider after the usage has been reserved,
  // and the refund that follows tells the user only that "the provider failed".
  const unsupported = unsupportedVideoRequestReason(
    (await loadAiVideoModelCapabilities()).get(selectedModel.modelId),
    {
      resolution,
      durationSeconds,
      aspectRatio: videoAspectRatio,
      generateAudio,
      ...(videoSeed === undefined ? {} : { seed: videoSeed }),
      frameImages: frameImages.length > 0,
    },
  );
  if (unsupported) {
    return {
      success: false,
      message: t("api-errors:aiModelDoesNotSupportRequest"),
    };
  }

  const identity = await requestIdentityOf(formData, "video.generate", {
    model: selectedModel.modelId,
    prompt,
    durationSeconds,
    resolution,
    aspectRatio: videoAspectRatio,
    generateAudio,
    ...(videoSeed === undefined ? {} : { seed: videoSeed }),
    ...frameDigests,
  });
  if (!identity) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }

  const callbackNonce = await createCallbackNonce();
  const cost = selectedModel.priceUnits * durationSeconds;
  const reservation = await createReservedAiJob({
    userId: session.user.id,
    kind: "video",
    provider: "openrouter",
    status: "queued",
    inputParams: {
      prompt,
      durationSeconds,
      resolution,
      aspectRatio: videoAspectRatio,
      generateAudio,
      ...(videoSeed === undefined ? {} : { seed: videoSeed }),
      ...frameParams,
    },
    usageUnits: cost,
    model: selectedModel.modelId,
    activeJobLimit: 1,
    callbackNonceHash: callbackNonce.hash,
    ...identity,
  });
  if (!reservation.ok) {
    return { success: false, message: t(`api-errors:${reservation.errorCode}`) };
  }
  const { job } = reservation;
  if (reservation.outcome === "existing") {
    return {
      success: true,
      jobId: job.id,
      url: job.resultFileId ? await getContentUrl(job.resultFileId) : null,
    };
  }

  const callbackUrl = await resolveVideoCallbackUrl(job.id, callbackNonce.nonce);

  try {
    await createAndAttachVideoJob({
      jobId: job.id,
      prompt,
      durationSeconds,
      resolution,
      aspectRatio: videoAspectRatio,
      generateAudio,
      ...(videoSeed === undefined ? {} : { seed: videoSeed }),
      ...(frameImages.length > 0 ? { frameImages } : {}),
      ...(callbackUrl === undefined ? {} : { callbackUrl }),
      callbackNonceHash: callbackNonce.hash,
      model: selectedModel.modelId,
    });
    return { success: true, jobId: job.id };
  } catch (error) {
    return await handleVideoSubmissionFailure({
      userId: session.user.id,
      jobId: job.id,
      error,
      t,
    });
  }
}

export async function listJobsAction(
  cursor?: { createdAt: string; id: string } | null,
): Promise<AiActionResult> {
  const session = await throwIfUnauth();
  const page = await listAiJobsByUserId({
    userId: session.user.id,
    limit: 20,
    ...(cursor ? { cursor: { createdAt: new Date(cursor.createdAt), id: cursor.id } } : {}),
  });
  const jobs = await Promise.all(
    page.jobs.map(async (job) => ({
      id: job.id,
      kind: job.kind,
      status: job.status,
      createdAt: job.createdAt.toISOString(),
      url: job.resultFileId ? await getContentUrl(job.resultFileId) : null,
      fileName: job.resultFile?.name ?? null,
      contentType: job.resultFile?.mimeType ?? null,
      inputParams: job.inputParams,
      canRetry: canRetryJob(job),
    })),
  );
  return {
    success: true,
    jobs,
    nextCursor: page.nextCursor
      ? {
          createdAt: page.nextCursor.createdAt.toISOString(),
          id: page.nextCursor.id,
        }
      : null,
  };
}

export async function retryJobAction(
  jobId: string,
  idempotencyKey: string,
): Promise<AiActionResult> {
  const session = await throwIfUnauth();
  const lang = await getLanguage();
  const { t } = await getTranslation(lang);
  const job = await getAiJobById({ jobId });
  if (!job || job.userId !== session.user.id) {
    return { success: false, message: t("api-errors:aiJobNotFound") };
  }
  if (job.status !== "failed" && job.status !== "succeeded") {
    return { success: false, message: t("api-errors:aiJobIsActive") };
  }
  const input = job.inputParams as Record<string, unknown> | null;
  if (!input || typeof input.prompt !== "string") {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }
  // A rerun repeats the request, so it repeats the model too. If that model has
  // since been disabled the retry is refused rather than moved to the default:
  // silently running something else and charging the default's price is not a
  // retry. Jobs from before the column existed carry no model and resolve to
  // the operation's default, which is what they ran on.
  const catalog = await loadAiModelCatalog();

  if (job.kind === "image") {
    // The reference image was never stored, so this would generate something
    // else and charge for it.
    if (input.reference) {
      return { success: false, message: t("api-errors:invalidRequestBody") };
    }
    // Required rather than defaulted: a generation always recorded its shape, so
    // a job without one is not a generation and must not be rerun as one. Jobs
    // predating aspect ratios carry the fixed size they were asked for.
    const aspectRatio =
      typeof input.aspectRatio === "string"
        ? (input.aspectRatio as AiImageAspectRatio)
        : typeof input.size === "string"
          ? aspectRatioOfLegacyImageSize(input.size)
          : null;
    if (aspectRatio === null || !AI_IMAGE_ASPECT_RATIOS.includes(aspectRatio)) {
      return { success: false, message: t("api-errors:invalidRequestBody") };
    }
    // Whatever the run recorded, rerun with the same. A background it no longer
    // recognizes is left off, which is what "auto" always meant.
    const background =
      typeof input.background === "string" &&
      AI_IMAGE_BACKGROUNDS.includes(input.background as AiImageBackground) &&
      input.background !== "auto"
        ? (input.background as AiImageBackground)
        : undefined;
    const seed = isAiSeed(input.seed) ? input.seed : undefined;
    const retryModel = catalog.resolve("image.generate", job.model);
    if (!retryModel) {
      return { success: false, message: t("api-errors:aiModelUnavailable") };
    }
    const identity = await toAiRequestIdentity({
      idempotencyKey,
      operation: "image.generate",
      input: {
        model: retryModel.modelId,
        prompt: input.prompt,
        aspectRatio,
        ...(background ? { background } : {}),
        ...(seed === undefined ? {} : { seed }),
      },
    });
    if (!identity) {
      return { success: false, message: t("api-errors:invalidRequestBody") };
    }
    const cost = retryModel.priceUnits;
    const reservation = await createReservedAiJob({
      userId: session.user.id,
      kind: "image",
      provider: "openrouter",
      status: "running",
      inputParams: {
        prompt: input.prompt,
        aspectRatio,
        ...(background ? { background } : {}),
        ...(seed === undefined ? {} : { seed }),
      },
      usageUnits: cost,
      model: retryModel.modelId,
      ...identity,
    });
    if (!reservation.ok) {
      return { success: false, message: t(`api-errors:${reservation.errorCode}`) };
    }
    const { job: retried } = reservation;
    if (reservation.outcome === "existing") {
      return { success: false, message: t("api-errors:aiRequestInProgress") };
    }
    try {
      const result = await generateImage({
        prompt: input.prompt,
        aspectRatio,
        ...(background ? { background } : {}),
        ...(seed === undefined ? {} : { seed }),
        model: retryModel.modelId,
      });
      const bytes = decodeGeneratedImageBase64(result.b64Json);
      await inspectGeneratedImage(bytes, result.mediaType);
      const file = await saveAiImage({
        jobId: retried.id,
        userId: session.user.id,
        bytes,
        mimeType: "image/png",
        filename: `ai-image-${retried.id}.png`,
      });
      return {
        success: true,
        jobId: retried.id,
        url: await getContentUrl(file.id),
        fileName: file.name,
        contentType: file.mimeType,
      };
    } catch (error) {
      await failAiJobAndRefundUsage({
        userId: session.user.id,
        aiJobId: retried.id,
        error: AI_JOB_FAILURE_MESSAGES.imageGeneration,
      });
      return { success: false, message: t(`api-errors:${errorMessage(error)}`) };
    }
  }

  if (job.kind === "video") {
    // The frames are not stored, so this would submit a different video and
    // charge for it. The button is hidden for these, but the rule belongs here.
    if (input.firstFrame || input.lastFrame) {
      return { success: false, message: t("api-errors:invalidRequestBody") };
    }
    const durationSeconds = Number(input.durationSeconds ?? 4);
    const resolution = String(input.resolution ?? "720p") as AiVideoResolution;
    // Jobs created before these existed carry neither; the defaults reproduce
    // what they were actually submitted with.
    const retryAspectRatio = String(
      input.aspectRatio ?? "16:9",
    ) as AiVideoAspectRatio;
    const retryGenerateAudio = input.generateAudio !== false;
    const retrySeed = isAiSeed(input.seed) ? input.seed : undefined;
    if (!isAiVideoDurationSeconds(durationSeconds)) {
      return { success: false, message: t("api-errors:invalidRequestBody") };
    }
    if (!AI_VIDEO_RESOLUTIONS.includes(resolution)) {
      return { success: false, message: t("api-errors:invalidRequestBody") };
    }
    if (!AI_VIDEO_ASPECT_RATIOS.includes(retryAspectRatio)) {
      return { success: false, message: t("api-errors:invalidRequestBody") };
    }
    const retryModel = catalog.resolve("video.generate", job.model);
    if (!retryModel) {
      return { success: false, message: t("api-errors:aiModelUnavailable") };
    }
    // What the model accepts can have changed since the original run, and a
    // rerun that the provider now refuses would be charged for first.
    const retryUnsupported = unsupportedVideoRequestReason(
      (await loadAiVideoModelCapabilities()).get(retryModel.modelId),
      {
        resolution,
        durationSeconds,
        aspectRatio: retryAspectRatio,
        generateAudio: retryGenerateAudio,
        ...(retrySeed === undefined ? {} : { seed: retrySeed }),
      },
    );
    if (retryUnsupported) {
      return {
        success: false,
        message: t("api-errors:aiModelDoesNotSupportRequest"),
      };
    }
    const identity = await toAiRequestIdentity({
      idempotencyKey,
      operation: "video.generate",
      input: {
        model: retryModel.modelId,
        prompt: input.prompt,
        durationSeconds,
        resolution,
        aspectRatio: retryAspectRatio,
        generateAudio: retryGenerateAudio,
        ...(retrySeed === undefined ? {} : { seed: retrySeed }),
      },
    });
    if (!identity) {
      return { success: false, message: t("api-errors:invalidRequestBody") };
    }
    const callbackNonce = await createCallbackNonce();
    const cost = retryModel.priceUnits * durationSeconds;
    const reservation = await createReservedAiJob({
      userId: session.user.id,
      kind: "video",
      provider: "openrouter",
      status: "queued",
      inputParams: {
        prompt: input.prompt,
        durationSeconds,
        resolution,
        aspectRatio: retryAspectRatio,
        generateAudio: retryGenerateAudio,
        ...(retrySeed === undefined ? {} : { seed: retrySeed }),
      },
      usageUnits: cost,
      model: retryModel.modelId,
      activeJobLimit: 1,
      callbackNonceHash: callbackNonce.hash,
      ...identity,
    });
    if (!reservation.ok) {
      return { success: false, message: t(`api-errors:${reservation.errorCode}`) };
    }
    const { job: retried } = reservation;
    if (reservation.outcome === "existing") {
      return { success: true, jobId: retried.id };
    }
    const callbackUrl = await resolveVideoCallbackUrl(
      retried.id,
      callbackNonce.nonce,
    );
    try {
      await createAndAttachVideoJob({
        jobId: retried.id,
        prompt: input.prompt,
        durationSeconds,
        resolution,
        aspectRatio: retryAspectRatio,
        generateAudio: retryGenerateAudio,
        ...(retrySeed === undefined ? {} : { seed: retrySeed }),
        ...(callbackUrl === undefined ? {} : { callbackUrl }),
        callbackNonceHash: callbackNonce.hash,
        model: retryModel.modelId,
      });
      return { success: true, jobId: retried.id };
    } catch (error) {
      return await handleVideoSubmissionFailure({
        userId: session.user.id,
        jobId: retried.id,
        error,
        t,
      });
    }
  }

  return { success: false, message: t("api-errors:invalidRequestBody") };
}

export async function refreshVideoJobAction(jobId: string): Promise<AiActionResult> {
  const session = await throwIfUnauth();
  const lang = await getLanguage();
  const { t } = await getTranslation(lang);
  const job = await getAiJobById({ jobId });
  if (!job || job.userId !== session.user.id) {
    return { success: false, message: t("api-errors:aiJobNotFound") };
  }
  // A submission whose outcome was unknown stays queued with no provider job
  // ID, waiting on the callback. Polling one throws, so without this the only
  // manual recovery the screen offers reports a permanent provider failure for
  // a job that is merely still waiting. The v3 route carries the same guard.
  if (
    job.kind === "video" &&
    job.status !== "succeeded" &&
    job.status !== "failed" &&
    job.providerJobId
  ) {
    try {
      const current = await synchronizeAiVideoJob({ job });
      if (!current) {
        return { success: false, message: t("api-errors:aiJobNotFound") };
      }
      return {
        success: true,
        jobId: current.id,
        status: current.status,
        url: current.resultFileId ? await getContentUrl(current.resultFileId) : null,
      };
    } catch (error) {
      console.error(`Failed to synchronize AI video job ${job.id}`, error);
      return { success: false, message: t("api-errors:aiProviderError") };
    }
  }
  return {
    success: true,
    jobId: job.id,
    status: job.status,
    url: job.resultFileId ? await getContentUrl(job.resultFileId) : null,
  };
}

export async function deleteJobAction(jobId: string): Promise<AiActionResult> {
  const session = await throwIfUnauth();
  const lang = await getLanguage();
  const { t } = await getTranslation(lang);
  const prepared = await prepareAiJobDeletionByUserId({
    userId: session.user.id,
    jobId,
  });
  if (prepared.outcome === "notFound") {
    return { success: false, message: t("api-errors:aiJobNotFound") };
  }
  if (prepared.outcome === "active") {
    return { success: false, message: t("api-errors:aiJobIsActive") };
  }
  if (prepared.outputFile) {
    await deleteAiOutputObject(prepared.outputFile.objectKey);
  }
  await finalizeAiJobDeletionByUserId({
    userId: session.user.id,
    jobId,
    outputFileId: prepared.outputFile?.id,
    outputObjectKey: prepared.outputFile?.objectKey,
  });
  return { success: true };
}
