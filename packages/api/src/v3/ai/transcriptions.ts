import { type Context, Hono } from "hono";
import { z } from "zod";
import { getUserId } from "../../api/auth";
import { apiErrorResponse } from "../../api/error";
import {
  createReservedAiJob,
  findReplayableAiJob,
  failAiJobAndRefundUsage,
} from "../../ai/credits";
import { getEntitlements } from "../../ai/entitlements";
import { parseAudio } from "../../ai/audio-metadata";
import {
  fileExceedsUploadLimit,
  isUploadLimitExceeded,
  MAX_AI_TRANSCRIPTION_UPLOAD_BYTES,
  parseBodyWithUploadLimit,
} from "../../ai/upload-limits";
import {
  AiProviderError,
  transcribeAudio,
} from "../../ai/openrouter";
import { AI_JOB_FAILURE_MESSAGES } from "../../ai/job-errors";
import { readAiJsonResult, saveAiJsonResult } from "../../ai/storage";
import { getAiJobResultFile } from "@beutl/db";
import { getAiRequestIdentity, sha256Hex } from "../../ai/request-integrity";
import { loadAiModelCatalog } from "../../ai/model-catalog";
import { validateTranscriptionResult } from "../../ai/audio-validation";
import { isIso6391LanguageCode } from "../../ai/subtitle-validation";

const languageSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(isIso6391LanguageCode);

// Speech recognition for caption automation: POST /api/v3/ai/transcriptions
// multipart/form-data: file (audio)
// Response includes the segments only. Balance snapshots, raw usage units, and
// exact per-operation credit deltas stay server-side.
// Duration is parsed from the uploaded media on the server and never trusted
// from a client-provided value.
// 既に使われた名前に対する答え。モデルの設定を見る前にも、予約が競合したあとにも
// 同じ形で返す。
async function answerFromExistingTranscription(
  c: Context,
  job: { id: string; status: string; resultFileId: string | null },
  { userId, durationSeconds }: { userId: string; durationSeconds: number },
) {
  if (job.status === "succeeded" && job.resultFileId) {
    const fileRecord = await getAiJobResultFile({ jobId: job.id, userId });
    if (fileRecord) {
      try {
        const stored = validateTranscriptionResult(
          (await readAiJsonResult({ objectKey: fileRecord.objectKey }) as {
            segments?: unknown;
            language?: unknown;
            words?: unknown;
          }),
          durationSeconds,
        );
        return c.json({
          jobId: job.id,
          segments: stored.segments,
          ...(stored.language ? { language: stored.language } : {}),
          ...(stored.words ? { words: stored.words } : {}),
        });
      } catch (error) {
        console.error("Failed to recover AI transcription result", error);
      }
    }
    // 支払い済みの成功ジョブを読み出せなかっただけで、ジョブが失敗したわけでは
    // ない。aiProviderError（＝返金済みの失敗）として返すと、クライアントはこの
    // キーを使い切ったものとして捨て、次の実行が新規課金になってしまう。同じ
    // キーでもう一度取りに来られる形で返す。
    return c.json(await apiErrorResponse("aiResultUnavailable"), { status: 503 });
  }
  if (
    job.status === "queued" ||
    job.status === "running" ||
    job.status === "finalizing"
  ) {
    return c.json(await apiErrorResponse("aiRequestInProgress"), { status: 409 });
  }
  return c.json(await apiErrorResponse("aiProviderError"), { status: 500 });
}

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
  const rawModel = body["model"];
  if (rawModel !== undefined && typeof rawModel !== "string") {
    return c.json(await apiErrorResponse("invalidRequestBody"), {
      status: 400,
    });
  }
  const catalog = await loadAiModelCatalog();
  const selectedModel = catalog.resolve("audio.transcribe", rawModel);

  const requestIdentity = await getAiRequestIdentity({
    request: c.req.raw,
    operation: "audio.transcribe",
    input: {
      fileName: file.name,
      contentType: file.type || "audio/mpeg",
      durationSeconds: parsedAudio.durationSeconds,
      contentSha256: await sha256Hex(parsedAudio.bytes),
      // 名指しされたときだけ。既定が入れ替わっても同じ名前で回収できるように。
      ...(rawModel ? { model: rawModel } : {}),
      ...(language ? { language } : {}),
    },
  });
  if (!requestIdentity) {
    return c.json(await apiErrorResponse("invalidRequestBody"), {
      status: 400,
    });
  }

  const replay = await findReplayableAiJob({ userId, ...requestIdentity });
  if (replay?.outcome === "existing") {
    return await answerFromExistingTranscription(c, replay.job, {
      userId,
      durationSeconds: parsedAudio.durationSeconds,
    });
  }
  if (replay?.outcome === "idempotencyConflict") {
    return c.json(await apiErrorResponse("invalidRequestBody"), { status: 409 });
  }
  if (replay?.outcome === "deleted") {
    return c.json(await apiErrorResponse("aiRequestWasDeleted"), { status: 409 });
  }

  // 回収するものが無かったので、これは新しい依頼。ここで初めて「今そのモデルが
  // 提供されているか」を問う。
  if (!selectedModel) {
    return c.json(await apiErrorResponse("aiModelUnavailable"), {
      status: 400,
    });
  }
  const cost = selectedModel.priceUnits * minutes;
  if (!Number.isSafeInteger(cost) || cost <= 0 || cost > 2_147_483_647) {
    return c.json(await apiErrorResponse("invalidRequestBody"), {
      status: 400,
    });
  }
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
    model: selectedModel.modelId,
    ...requestIdentity,
  });
  if (!reservation.ok) {
    return c.json(await apiErrorResponse(reservation.errorCode), {
      status: reservation.status,
    });
  }
  const { job } = reservation;
  if (reservation.outcome === "existing") {
    // 同時に届いた 2 本のうち、予約が決着をつけたほう。
    return await answerFromExistingTranscription(c, job, {
      userId,
      durationSeconds: parsedAudio.durationSeconds,
    });
  }

  try {
    const result = await transcribeAudio({
      audio: parsedAudio.bytes,
      durationSeconds: parsedAudio.durationSeconds,
      filename: file.name,
      mimeType: file.type || "audio/mpeg",
      ...(language ? { language } : {}),
      model: selectedModel.modelId,
      signal: c.req.raw.signal,
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
