import { type Context, Hono } from "hono";
import { z } from "zod";
import { getUserId } from "../../api/auth";
import { apiErrorResponse } from "../../api/error";
import {
  findReplayableAiJob,
  aiJobStateForIdempotencyKey,
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
  aiProviderFailureCode,
} from "../../ai/openrouter";
import { publicAiJobError } from "../../ai/job-errors";
import {
  getAiIdempotencyKeyHash,
  getAiRequestIdentity,
  sha256Hex,
} from "../../ai/request-integrity";
import { loadAiModelCatalog } from "../../ai/model-catalog";
import { prepareTranscription, recoverTranscription } from "../../ai/transcription";
import { isIso6391LanguageCode } from "../../ai/subtitle-validation";
import { aiApiMultipartBodyLimit } from "@beutl/core";

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
  job: { id: string; status: string; resultFileId: string | null; error?: string | null },
  { userId, durationSeconds }: { userId: string; durationSeconds: number },
) {
  if (job.status === "succeeded" && job.resultFileId) {
    const stored = await recoverTranscription({ jobId: job.id, userId, durationSeconds });
    if (stored) return c.json({ jobId: job.id, ...stored });
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
  return c.json(await apiErrorResponse(publicAiJobError(job.error)), { status: 500 });
}

const app = new Hono().post("/", async (c) => {
  const userId = await getUserId(c);
  if (!userId) {
    return c.json(await apiErrorResponse("authenticationIsRequired"), {
      status: 401,
    });
  }

  // 契約が無ければ、大きな本文を読み込む前に断る。ただし、その名前が取りに来る
  // 価値のある job を指しているなら別——契約中に課金された結果は、契約が終わった
  // あとでも取りに来られなければならない。名前は自分の job しか指せない。
  const idempotencyKeyHash = await getAiIdempotencyKeyHash(c.req.raw);
  if (!idempotencyKeyHash) {
    return c.json(await apiErrorResponse("invalidRequestBody"), {
      status: 400,
    });
  }
  const keyState = await aiJobStateForIdempotencyKey({
    userId,
    idempotencyKeyHash,
  });
  // 指していた job が消えているなら、本文を読む必要はない。
  if (keyState === "deleted") {
    return c.json(await apiErrorResponse("aiRequestWasDeleted"), {
      status: 409,
    });
  }

  const entitlements = await getEntitlements(userId, {
    videoCapabilities: new Map(),
  });
  if (keyState !== "collectable") {
    const recoverableDenial = async () =>
      c.json(await apiErrorResponse("aiRequestInProgress"), { status: 409 });
    if (!entitlements.canUseAi) {
      return keyState === "none"
        ? await recoverableDenial()
        : c.json(await apiErrorResponse("aiPlanRequired"), { status: 402 });
    }
    const modelAvailability =
      entitlements.modelAvailability["audio.transcribe"] ?? {};
    if (Object.keys(modelAvailability).length === 0) {
      return keyState === "none"
        ? await recoverableDenial()
        : c.json(await apiErrorResponse("aiModelUnavailable"), { status: 400 });
    }
    if (!entitlements.availability["audio.transcribe"]) {
      return keyState === "none"
        ? await recoverableDenial()
        : c.json(await apiErrorResponse("aiUsageLimitExceeded"), { status: 402 });
    }
  }
  let body: Awaited<ReturnType<typeof c.req.parseBody>>;
  try {
    body = await parseBodyWithUploadLimit(
      c.req,
      MAX_AI_TRANSCRIPTION_UPLOAD_BYTES,
      aiApiMultipartBodyLimit("/api/v3/ai/transcriptions")!,
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
    // parseAudio throws only for audio it cannot read, which is the caller's input.
    return c.json(await apiErrorResponse("invalidRequestBody"), {
      status: 400,
    });
  }

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
      // ブラウザが名乗る種類は数えない。同じ音声でも、選び方や取り込み元で
      // 変わることがあり、そのたびに別の依頼になる——中身のハッシュと長さが
      // 音声を見分けるので、これが無くて困ることはない。逆に数えると、送り手
      // には同じ依頼に見えるものが指紋だけ食い違い、その名前では二度と通らない。
      fileName: file.name,
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
    return c.json(await apiErrorResponse("aiRequestChanged"), { status: 409 });
  }
  if (replay?.outcome === "deleted") {
    return c.json(await apiErrorResponse("aiRequestWasDeleted"), { status: 409 });
  }

  const reservation = await prepareTranscription({
    userId, model: selectedModel, identity: requestIdentity,
    input: {
      audio: parsedAudio.bytes, durationSeconds: parsedAudio.durationSeconds,
      filename: file.name, mimeType: file.type || "audio/mpeg",
      ...(language ? { language } : {}),
    },
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

  const outcome = await reservation.execute({ signal: c.req.raw.signal });
  if (!outcome.ok) {
    if (!(outcome.error instanceof AiProviderError)) {
      console.error("Failed to persist AI transcription result", outcome.error);
    }
    return c.json(await apiErrorResponse(aiProviderFailureCode(outcome.error)), { status: 500 });
  }
  return c.json({ jobId: job.id, ...outcome.transcript });
});

export default app;
