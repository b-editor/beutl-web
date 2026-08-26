export {
  MAX_AI_PROMPT_LENGTH,
  MAX_AI_TRANSCRIPTION_UPLOAD_BYTES,
  MULTIPART_OVERHEAD_BYTES,
  MAX_AI_IMAGE_UPLOAD_BYTES,
  MAX_AI_IMAGE_REFERENCES_TOTAL_BYTES,
  MAX_AI_VIDEO_FRAME_UPLOAD_BYTES,
  MAX_AI_TRANSLATION_JSON_REQUEST_BYTES,
} from "@beutl/core";
import {
  aiApiMultipartBodyLimit as canonicalAiApiMultipartBodyLimit,
  MULTIPART_OVERHEAD_BYTES,
  RequestBodyLimitExceededError,
  boundedBody,
} from "@beutl/core";

export function aiApiMultipartBodyLimit(pathname: string): number | null {
  return canonicalAiApiMultipartBodyLimit(pathname);
}

export const MAX_AI_JSON_REQUEST_BYTES = 32 * 1024;

export class UploadLimitExceededError extends RequestBodyLimitExceededError {
  constructor() {
    super("Upload body exceeds the configured limit");
    this.name = "UploadLimitExceededError";
  }
}

export function requestUploadLimit(maxFileBytes: number): number {
  return maxFileBytes + MULTIPART_OVERHEAD_BYTES;
}

function requestExceedsBodyLimit(request: Request, maximumBytes: number): boolean {
  const header = request.headers.get("content-length");
  if (!header) return false;
  const contentLength = Number(header);
  return Number.isFinite(contentLength) && contentLength > maximumBytes;
}

function boundedRequestBody(request: Request, maximumBytes: number): Request {
  if (!request.body) return request;
  const body = boundedBody(request.body, maximumBytes);
  return new Request(request.url, {
    method: request.method, headers: request.headers, body, signal: request.signal,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

export function isUploadLimitExceeded(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5; depth++) {
    if (
      current instanceof UploadLimitExceededError ||
      current instanceof RequestBodyLimitExceededError
    ) return true;
    if (
      typeof current !== "object" ||
      current === null ||
      !("cause" in current)
    ) {
      return false;
    }
    current = current.cause;
  }
  return false;
}

export async function parseBodyWithUploadLimit<T>(
  request: { raw: Request; parseBody(): Promise<T> },
  maxFileBytes: number,
  maxBodyBytes = requestUploadLimit(maxFileBytes),
): Promise<T> {
  if (requestExceedsBodyLimit(request.raw, maxBodyBytes)) {
    throw new UploadLimitExceededError();
  }
  request.raw = boundedRequestBody(
    request.raw,
    maxBodyBytes,
  );
  return await request.parseBody();
}

export async function parseJsonWithBodyLimit<T>(
  request: { raw: Request; json(): Promise<T> },
  maximumBytes = MAX_AI_JSON_REQUEST_BYTES,
): Promise<T> {
  if (requestExceedsBodyLimit(request.raw, maximumBytes)) {
    throw new UploadLimitExceededError();
  }
  request.raw = boundedRequestBody(request.raw, maximumBytes);
  return await request.json();
}

export function fileExceedsUploadLimit(
  file: File,
  maxFileBytes: number,
): boolean {
  return file.size > maxFileBytes;
}
