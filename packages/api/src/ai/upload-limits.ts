export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export const MAX_AI_IMAGE_UPLOAD_BYTES = 20 * 1024 * 1024;
// Two frame images are embedded as base64 data URLs and then copied again by
// JSON serialization. Keep this substantially below the ordinary image-edit
// limit so a two-frame request stays within the Worker's memory budget.
export const MAX_AI_VIDEO_FRAME_UPLOAD_BYTES = 5 * 1024 * 1024;
export {
  MAX_AI_PROMPT_LENGTH,
  MAX_AI_TRANSCRIPTION_UPLOAD_BYTES,
} from "@beutl/core";
export const MAX_AI_JSON_REQUEST_BYTES = 32 * 1024;
// A canonical maximum-size translation payload can contain 200 64-character
// IDs plus 20,000 multi-byte UTF-8 text characters.
export const MAX_AI_TRANSLATION_JSON_REQUEST_BYTES = 128 * 1024;

export class UploadLimitExceededError extends Error {
  constructor() {
    super("Upload body exceeds the configured limit");
    this.name = "UploadLimitExceededError";
  }
}

export function requestUploadLimit(maxFileBytes: number): number {
  return maxFileBytes + MULTIPART_OVERHEAD_BYTES;
}

export function requestExceedsUploadLimit(
  request: Request,
  maxFileBytes: number,
): boolean {
  return requestExceedsBodyLimit(
    request,
    requestUploadLimit(maxFileBytes),
  );
}

function requestExceedsBodyLimit(
  request: Request,
  maximumBytes: number,
): boolean {
  const header = request.headers.get("content-length");
  if (!header) return false;

  const contentLength = Number(header);
  return (
    Number.isFinite(contentLength) &&
    contentLength > maximumBytes
  );
}

function boundedRequestBody(request: Request, maximumBytes: number): Request {
  if (!request.body) return request;

  const source = request.body.getReader();
  let consumedBytes = 0;
  const body = new ReadableStream<Uint8Array>({
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

      consumedBytes += next.value.byteLength;
      if (consumedBytes > maximumBytes) {
        const error = new UploadLimitExceededError();
        await source.cancel(error).catch(() => undefined);
        controller.error(error);
        return;
      }
      controller.enqueue(next.value);
    },
    async cancel(reason) {
      await source.cancel(reason).catch(() => undefined);
    },
  });

  // Built from the URL rather than by copying the request that came in. Copying
  // it works on workerd and under the test runner, but on Node the incoming
  // request belongs to the server's own Request class, and the copy then reads
  // as an object of a different class: `Cannot read private member #state`,
  // raised only when the body is finally read. That surfaced as every AI
  // request from the editor being refused as an invalid body.
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    signal: request.signal,
    // Required by Node's Request implementation and ignored by workerd.
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

export function isUploadLimitExceeded(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5; depth++) {
    if (current instanceof UploadLimitExceededError) return true;
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
): Promise<T> {
  if (requestExceedsUploadLimit(request.raw, maxFileBytes)) {
    throw new UploadLimitExceededError();
  }
  request.raw = boundedRequestBody(
    request.raw,
    requestUploadLimit(maxFileBytes),
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
