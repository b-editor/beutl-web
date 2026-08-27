import {
  aiApiMultipartBodyLimit,
  aiScreenUploadLimit,
  MAX_AI_TRANSLATION_JSON_REQUEST_BYTES,
} from "./ai-capabilities";
import { STORAGE_UPLOAD_PART_BYTES } from "./storage-quota";

/**
 * 1 リクエストの本文に許す大きさ。
 *
 * next.config.mjs の `serverActions.bodySizeLimit` と同じ数——いちばん大きいもの、
 * パッケージの送信に合わせてある。二つに分かれているのは、あちらが Next の設定で
 * 文字列、こちらが Worker の入口で数だから。片方だけ動かすと、通ったものが次で
 * 断られる。
 */
export const MAX_REQUEST_BODY_BYTES = 100 * 1024 * 1024;
export const MAX_API_JSON_REQUEST_BYTES = 32 * 1024;
export const MAX_AUTH_REQUEST_BODY_BYTES = 64 * 1024;
export const MAX_INTERNAL_STORAGE_START_BODY_BYTES = 4 * 1024;
export const MAX_INTERNAL_STORAGE_FINISH_BODY_BYTES = 64 * 1024;
export const MAX_STRIPE_WEBHOOK_BODY_BYTES = 1024 * 1024;
export const MAX_OPENROUTER_CALLBACK_BODY_BYTES = 64 * 1024;

/** A request body crossed the limit while it was being consumed. */
export class RequestBodyLimitExceededError extends Error {
  constructor(message = "Request body exceeds the configured limit") {
    super(message);
    this.name = "RequestBodyLimitExceededError";
  }
}

function isMultipart(contentType: string | null): boolean {
  return contentType?.toLowerCase().startsWith("multipart/form-data") === true;
}

function isJson(contentType: string | null): boolean {
  return contentType?.toLowerCase().startsWith("application/json") === true;
}

/** Body limit for routes mounted by the standalone or fallback API. */
export function apiRequestBodyLimit(
  method: string,
  pathname: string,
  contentType: string | null,
): number {
  const normalizedMethod = method.toUpperCase();
  const path = pathname.length > 1 ? pathname.replace(/\/+$/u, "") : pathname;
  if (
    normalizedMethod === "POST" &&
    /^\/api\/v3\/ai\/videos\/[^/]+\/openrouter-callback$/u.test(path)
  ) {
    return MAX_OPENROUTER_CALLBACK_BODY_BYTES;
  }

  // Kept explicit even though the standalone API does not currently mount the
  // Web storage route. If it is mounted later, a raw part remains a valid part
  // rather than falling through to the JSON cap.
  if (
    normalizedMethod === "PUT" &&
    /^\/api\/internal\/storage\/uploads\/[^/]+\/parts\/\d+$/u.test(path)
  ) {
    return STORAGE_UPLOAD_PART_BYTES;
  }

  const multipartLimit = normalizedMethod === "POST" && isMultipart(contentType)
    ? aiApiMultipartBodyLimit(path)
    : null;
  if (multipartLimit !== null) return multipartLimit;

  if (
    normalizedMethod === "POST" &&
    path === "/api/v3/ai/translations" &&
    (contentType === null || isJson(contentType))
  ) {
    return MAX_AI_TRANSLATION_JSON_REQUEST_BYTES;
  }
  return MAX_API_JSON_REQUEST_BYTES;
}

/**
 * Select the OpenNext outer cap before its generated handler buffers a body.
 * The matrix is method-sensitive so a binary allowance cannot be borrowed by
 * posting to a different handler at the same path.
 */
export function requestBodyLimit(
  pathname: string,
  method = "POST",
  contentType: string | null = null,
): number {
  const normalizedMethod = method.toUpperCase();
  const path = pathname.length > 1 ? pathname.replace(/\/+$/u, "") : pathname;

  if (path === "/api/auth" || path.startsWith("/api/auth/")) {
    return MAX_AUTH_REQUEST_BODY_BYTES;
  }
  if (normalizedMethod === "POST" && path === "/api/stripe/webhook") {
    // Stripe requires the exact raw bytes for signature verification. The
    // outer stream only counts them; it never parses or rewrites the payload.
    return MAX_STRIPE_WEBHOOK_BODY_BYTES;
  }
  if (
    normalizedMethod === "POST" &&
    path === "/api/internal/storage/uploads"
  ) {
    return MAX_INTERNAL_STORAGE_START_BODY_BYTES;
  }
  if (
    normalizedMethod === "POST" &&
    /^\/api\/internal\/storage\/uploads\/[^/]+$/u.test(path)
  ) {
    return MAX_INTERNAL_STORAGE_FINISH_BODY_BYTES;
  }
  if (
    normalizedMethod === "PUT" &&
    /^\/api\/internal\/storage\/uploads\/[^/]+\/parts\/\d+$/u.test(path)
  ) {
    return STORAGE_UPLOAD_PART_BYTES;
  }
  if (path.startsWith("/api/internal/ai/")) {
    return apiRequestBodyLimit(
      normalizedMethod,
      path.replace(/^\/api\/internal\/ai\//u, "/api/v3/ai/"),
      contentType,
    );
  }
  if (/^\/api\/v[123](?:\/|$)/u.test(path)) {
    return apiRequestBodyLimit(normalizedMethod, path, contentType);
  }
  if (path.startsWith("/api/internal/")) {
    return MAX_API_JSON_REQUEST_BYTES;
  }
  if (path.startsWith("/api/")) {
    return MAX_API_JSON_REQUEST_BYTES;
  }

  const screenLimit = aiScreenUploadLimit(path);
  if (normalizedMethod === "POST" && screenLimit !== null) return screenLimit;

  // Generic pages include Server Actions for package and release assets. Their
  // action ids are opaque Next-Action headers, so the application-wide 100 MiB
  // cap remains the explicit fallback for those page POSTs.
  return MAX_REQUEST_BODY_BYTES;
}

/**
 * 長さを名乗らない本文を、数えながら通す。上限を超えたところで切る。
 *
 * 名乗った長さは信じない——名乗らずに送ることも、名乗った以上に送ることもできる
 * ので、実際に流れたぶんを数える。切られた本文は下流で読めずに終わるが、抱えた
 * まま増え続けるよりはいい。
 */
export function boundedBody(
  body: ReadableStream<Uint8Array>,
  limit: number,
  onLimitExceeded?: () => void,
): ReadableStream<Uint8Array> {
  const source = body.getReader();
  let seen = 0;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let next: ReadableStreamReadResult<Uint8Array>;
        try {
          next = await source.read();
        } catch (error) {
          controller.error(error);
          return;
        }
        if (next.done) {
          controller.close();
          return;
        }

        seen += next.value.byteLength;
        if (seen > limit) {
          onLimitExceeded?.();
          const error = new RequestBodyLimitExceededError();
          await source.cancel(error).catch(() => undefined);
          controller.error(error);
          return;
        }
        controller.enqueue(next.value);
      },
      async cancel(reason) {
        await source.cancel(reason).catch(() => undefined);
      },
    },
    // Avoid pulling one chunk merely to fill the wrapper's queue. An endpoint
    // that rejects before reading its body should keep that response and should
    // not spend memory on a body it never needed.
    { highWaterMark: 0 },
  );
}
