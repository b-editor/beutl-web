import { Hono } from "hono";
import { z } from "zod";
import { getUserId } from "../../api/auth";
import { apiErrorResponse } from "../../api/error";
import {
  createReservedAiJob,
  failAiJobAndRefundUsage,
} from "../../ai/credits";
import { loadAiSettings } from "../../ai/settings";
import { getEntitlements } from "../../ai/entitlements";
import { parseAudio } from "../../ai/audio-metadata";
import {
  fileExceedsUploadLimit,
  isUploadLimitExceeded,
  MAX_AI_TRANSCRIPTION_UPLOAD_BYTES,
  parseBodyWithUploadLimit,
} from "../../ai/upload-limits";
import { AiProviderError, transcribeAudio } from "../../ai/openrouter";
import { AI_JOB_FAILURE_MESSAGES } from "../../ai/job-errors";
import { saveAiJsonResult } from "../../ai/storage";

const iso6391LanguageCodes = new Set(
  [
    "aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs",
    "ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff",
    "fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id",
    "ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku",
    "kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my",
    "na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu",
    "rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv",
    "sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo",
    "wa wo xh yi yo za zh zu",
  ].flatMap((group) => group.split(" ")),
);

const languageSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine((value) => iso6391LanguageCodes.has(value));

// 音声認識 (字幕自動化): POST /api/v3/ai/transcriptions
// multipart/form-data: file (audio)
// Response includes the segments only. Balance snapshots, raw usage units, and
// exact per-operation credit deltas stay server-side.
// Duration is parsed from the uploaded media on the server and never trusted
// from a client-provided value.
const app = new Hono().post("/", async (c) => {
  const userId = await getUserId(c);
  if (!userId) {
    return c.json(await apiErrorResponse("authenticationIsRequired"), {
      status: 401,
    });
  }

  const entitlements = await getEntitlements(userId);
  if (!entitlements.canUseAi) {
    return c.json(await apiErrorResponse("aiPlanRequired"), {
      status: 402,
    });
  }
  let body: Awaited<ReturnType<typeof c.req.parseBody>>;
  try {
    body = await parseBodyWithUploadLimit(
      c.req,
      MAX_AI_TRANSCRIPTION_UPLOAD_BYTES,
    );
  } catch (error) {
    if (isUploadLimitExceeded(error)) {
      return c.json(await apiErrorResponse("fileIsTooLarge"), {
        status: 413,
      });
    }
    throw error;
  }
  const file = body["file"];
  const rawLanguage = body["language"];
  if (
    file instanceof File &&
    fileExceedsUploadLimit(file, MAX_AI_TRANSCRIPTION_UPLOAD_BYTES)
  ) {
    return c.json(await apiErrorResponse("fileIsTooLarge"), {
      status: 413,
    });
  }
  if (!(file instanceof File) || file.size === 0) {
    return c.json(await apiErrorResponse("invalidRequestBody"), {
      status: 400,
    });
  }
  const parsedLanguage =
    rawLanguage === undefined
      ? { success: true as const, data: undefined }
      : languageSchema.safeParse(rawLanguage);
  if (!parsedLanguage.success) {
    return c.json(await apiErrorResponse("invalidRequestBody"), {
      status: 400,
    });
  }
  const language = parsedLanguage.data;

  let parsedAudio: Awaited<ReturnType<typeof parseAudio>>;
  try {
    parsedAudio = await parseAudio(file);
  } catch {
    return c.json(await apiErrorResponse("invalidRequestBody"), {
      status: 400,
    });
  }

  const minutes = Math.max(1, Math.ceil(parsedAudio.durationSeconds / 60));
  const settings = await loadAiSettings();
  const cost = settings.getPrice("audio.transcribe") * minutes;
  const reservation = await createReservedAiJob({
    userId,
    kind: "stt",
    provider: "openrouter",
    status: "running",
    inputParams: {
      filename: file.name,
      durationSeconds: parsedAudio.durationSeconds,
      ...(language ? { language } : {}),
    },
    usageUnits: cost,
  });
  if (!reservation.ok) {
    return c.json(await apiErrorResponse(reservation.errorCode), {
      status: reservation.status,
    });
  }
  const { job } = reservation;

  try {
    const result = await transcribeAudio({
      audio: parsedAudio.bytes,
      filename: file.name,
      mimeType: file.type || "audio/mpeg",
      ...(language ? { language } : {}),
      model: settings.getModel("audio.transcribe"),
    });
    await saveAiJsonResult({
      jobId: job.id,
      userId,
      filename: `transcription-${job.id}.json`,
      result: {
        version: 1,
        kind: "stt",
        segments: result.segments,
        ...(result.language ? { language: result.language } : {}),
        ...(result.words ? { words: result.words } : {}),
      },
    });

    return c.json({
      jobId: job.id,
      segments: result.segments,
      ...(result.language ? { language: result.language } : {}),
      ...(result.words ? { words: result.words } : {}),
    });
  } catch (err) {
    await failAiJobAndRefundUsage({
      userId,
      aiJobId: job.id,
      error: AI_JOB_FAILURE_MESSAGES.transcription,
    });
    if (err instanceof AiProviderError) {
      return c.json(await apiErrorResponse("aiProviderError"), {
        status: 500,
      });
    }
    console.error("Failed to persist AI transcription result", err);
    return c.json(await apiErrorResponse("aiProviderError"), {
      status: 500,
    });
  }
});

export default app;
