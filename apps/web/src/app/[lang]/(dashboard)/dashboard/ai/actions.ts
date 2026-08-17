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
  loadAiSettings,
  parseAudio,
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
  validateAiInputImage,
  type AiInputImageMimeType,
  type ImageEditTask,
  type ImageGenerationSize,
} from "@beutl/api";
import {
  finalizeAiJobDeletionByUserId,
  getAiJobById,
  listAiJobsByUserId,
  prepareAiJobDeletionByUserId,
} from "@beutl/db";
import {
  classifyVideoSubmissionFailure,
  createAndAttachVideoJob,
  deleteAiOutputObject,
} from "@beutl/api";
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

function composePrompt({
  main,
  style,
  composition,
  motion,
  exclusions,
}: {
  main: string;
  style?: string;
  composition?: string;
  motion?: string;
  exclusions?: string;
}): string {
  const sections: string[] = [];
  const addSection = (label: string | null, value: string | undefined) => {
    const normalized = value?.trim().replace(/\s+/g, " ");
    if (normalized) {
      sections.push(label === null ? normalized : `${label}: ${normalized}`);
    }
  };
  addSection(null, main);
  addSection("Style", style);
  addSection("Composition", composition);
  addSection("Motion", motion);
  addSection("Avoid", exclusions);
  return sections.join("\n");
}

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
  const size = String(formData.get("size") ?? "1024x1024") as ImageGenerationSize;
  if (!prompt || prompt.length > MAX_AI_PROMPT_LENGTH) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }
  if (!["1024x1024", "1024x1536", "1536x1024"].includes(size)) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }

  const identity = await requestIdentityOf(formData, "image.generate", {
    prompt,
    size,
  });
  if (!identity) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }

  const settings = await loadAiSettings();
  const cost = settings.getPrice("image.generate");
  const reservation = await createReservedAiJob({
    userId: session.user.id,
    kind: "image",
    provider: "openrouter",
    status: "running",
    inputParams: { prompt, size },
    usageUnits: cost,
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
      size,
      model: settings.getModel("image.generate"),
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
  const validTasks = new Set<ImageEditTask>([
    "remove_background",
    "upscale",
    "restyle",
    "remove_object",
    "outpaint",
  ]);
  if (!validTasks.has(task)) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }
  const promptRequiredTasks = new Set<ImageEditTask>([
    "restyle",
    "remove_object",
    "outpaint",
  ]);
  if (promptRequiredTasks.has(task) && !prompt) {
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

  const settings = await loadAiSettings();
  const cost = settings.getPrice(`image.edit.${task}`);
  const editPrompt =
    task === "outpaint"
      ? `Extend the image naturally into the transparent canvas while preserving the original center. ${prompt}`
      : prompt;
  const identity = await requestIdentityOf(formData, `image.edit.${task}`, {
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
      model: settings.getModel(`image.edit.${task}`),
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
  const identity = await requestIdentityOf(formData, "audio.transcribe", {
    fileName: file.name,
    contentType: file.type || "audio/mpeg",
    durationSeconds: parsedAudio.durationSeconds,
    contentSha256: await sha256Hex(parsedAudio.bytes),
    ...(language ? { language } : {}),
  });
  if (!identity) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }
  const settings = await loadAiSettings();
  const cost = settings.getPrice("audio.transcribe") * minutes;
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
    ...identity,
  });
  if (!reservation.ok) {
    return { success: false, message: t(`api-errors:${reservation.errorCode}`) };
  }
  const { job } = reservation;
  if (reservation.outcome === "existing") {
    if (job.status === "succeeded" && job.resultFileId) {
      return { success: true, jobId: job.id, url: await getContentUrl(job.resultFileId) };
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
      model: settings.getModel("audio.transcribe"),
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
    segments = parsed.map((item) => {
      const record = item as { id?: unknown; text?: unknown };
      if (
        typeof record.id !== "string" ||
        !SAFE_SEGMENT_ID_PATTERN.test(record.id) ||
        typeof record.text !== "string" ||
        record.text.trim().length === 0
      ) {
        throw new Error("invalid segment");
      }
      return { id: record.id, text: record.text };
    });
  } catch {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }
  const characterCount = segments.reduce((total, s) => total + s.text.length, 0);
  if (characterCount > MAX_TRANSLATION_CHARACTERS) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }

  const identity = await requestIdentityOf(formData, "subtitle.translate", {
    ...(sourceLanguage ? { sourceLanguage } : {}),
    targetLanguage,
    segments,
  });
  if (!identity) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }

  const settings = await loadAiSettings();
  const usageUnits =
    settings.getPrice("subtitle.translate") *
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
    ...identity,
  });
  if (!reservation.ok) {
    return { success: false, message: t(`api-errors:${reservation.errorCode}`) };
  }
  const { job } = reservation;
  if (reservation.outcome === "existing") {
    if (job.status === "succeeded" && job.resultFileId) {
      return { success: true, jobId: job.id, url: await getContentUrl(job.resultFileId) };
    }
    return { success: false, message: t("api-errors:aiRequestInProgress") };
  }

  try {
    const translated = await translateSegments({
      ...(sourceLanguage ? { sourceLanguage } : {}),
      targetLanguage,
      segments,
      model: settings.getModel("subtitle.translate"),
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
        segments: translated,
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
  const resolution = String(formData.get("resolution") ?? "720p") as "720p" | "1080p";
  if (!prompt || prompt.length > MAX_AI_PROMPT_LENGTH) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }
  if (![4, 6, 8].includes(durationSeconds)) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }
  if (resolution !== "720p" && resolution !== "1080p") {
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
    }
  }

  const identity = await requestIdentityOf(formData, "video.generate", {
    prompt,
    durationSeconds,
    resolution,
    ...frameDigests,
  });
  if (!identity) {
    return { success: false, message: t("api-errors:invalidRequestBody") };
  }

  const callbackNonce = await createCallbackNonce();
  const settings = await loadAiSettings();
  const cost = settings.getPrice("video.generate") * durationSeconds;
  const reservation = await createReservedAiJob({
    userId: session.user.id,
    kind: "video",
    provider: "openrouter",
    status: "queued",
    inputParams: { prompt, durationSeconds, resolution },
    usageUnits: cost,
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

  const origin = await resolveOrigin();
  const callbackUrl = new URL(
    `/api/v3/ai/videos/${encodeURIComponent(job.id)}/openrouter-callback`,
    origin,
  );
  callbackUrl.searchParams.set("nonce", callbackNonce.nonce);

  try {
    await createAndAttachVideoJob({
      jobId: job.id,
      prompt,
      durationSeconds,
      resolution,
      ...(frameImages.length > 0 ? { frameImages } : {}),
      callbackUrl: callbackUrl.toString(),
      callbackNonceHash: callbackNonce.hash,
      model: settings.getModel("video.generate"),
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
      canRetry:
        (job.status === "failed" || job.status === "succeeded") &&
        (job.kind === "image" || job.kind === "video") &&
        job.inputParams !== null &&
        typeof job.inputParams === "object" &&
        "prompt" in job.inputParams &&
        typeof job.inputParams.prompt === "string",
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

  if (job.kind === "image") {
    // Required rather than defaulted: a generation always stored its size, so a
    // job without one is not a generation and must not be rerun as one.
    const size = input.size;
    if (
      typeof size !== "string" ||
      !["1024x1024", "1024x1536", "1536x1024"].includes(size)
    ) {
      return { success: false, message: t("api-errors:invalidRequestBody") };
    }
    const identity = await toAiRequestIdentity({
      idempotencyKey,
      operation: "image.generate",
      input: { prompt: input.prompt, size },
    });
    if (!identity) {
      return { success: false, message: t("api-errors:invalidRequestBody") };
    }
    const settings = await loadAiSettings();
    const cost = settings.getPrice("image.generate");
    const reservation = await createReservedAiJob({
      userId: session.user.id,
      kind: "image",
      provider: "openrouter",
      status: "running",
      inputParams: { prompt: input.prompt, size },
      usageUnits: cost,
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
        size: size as ImageGenerationSize,
        model: settings.getModel("image.generate"),
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
    const durationSeconds = Number(input.durationSeconds ?? 4);
    const resolution = String(input.resolution ?? "720p") as "720p" | "1080p";
    if (![4, 6, 8].includes(durationSeconds)) {
      return { success: false, message: t("api-errors:invalidRequestBody") };
    }
    if (resolution !== "720p" && resolution !== "1080p") {
      return { success: false, message: t("api-errors:invalidRequestBody") };
    }
    const identity = await toAiRequestIdentity({
      idempotencyKey,
      operation: "video.generate",
      input: { prompt: input.prompt, durationSeconds, resolution },
    });
    if (!identity) {
      return { success: false, message: t("api-errors:invalidRequestBody") };
    }
    const callbackNonce = await createCallbackNonce();
    const settings = await loadAiSettings();
    const cost = settings.getPrice("video.generate") * durationSeconds;
    const reservation = await createReservedAiJob({
      userId: session.user.id,
      kind: "video",
      provider: "openrouter",
      status: "queued",
      inputParams: { prompt: input.prompt, durationSeconds, resolution },
      usageUnits: cost,
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
    const origin = await resolveOrigin();
    const callbackUrl = new URL(
      `/api/v3/ai/videos/${encodeURIComponent(retried.id)}/openrouter-callback`,
      origin,
    );
    callbackUrl.searchParams.set("nonce", callbackNonce.nonce);
    try {
      await createAndAttachVideoJob({
        jobId: retried.id,
        prompt: input.prompt,
        durationSeconds,
        resolution,
        callbackUrl: callbackUrl.toString(),
        callbackNonceHash: callbackNonce.hash,
        model: settings.getModel("video.generate"),
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
  const job = await getAiJobById({ jobId });
  if (!job || job.userId !== session.user.id) {
    return { success: false, message: "aiJobNotFound" };
  }
  if (job.kind === "video" && job.status !== "succeeded" && job.status !== "failed") {
    try {
      const current = await synchronizeAiVideoJob({ job });
      if (!current) {
        return { success: false, message: "aiJobNotFound" };
      }
      return {
        success: true,
        jobId: current.id,
        status: current.status,
        url: current.resultFileId ? await getContentUrl(current.resultFileId) : null,
      };
    } catch {
      return { success: false, message: "aiProviderError" };
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
