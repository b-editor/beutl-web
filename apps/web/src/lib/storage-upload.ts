import { INTERNAL_REQUEST_HEADERS } from "./internal-request";

// Sending a file that one request cannot carry.
//
// The file is cut into parts and each part is sent on its own, because the
// platform stops a request body at 100 MB. The pieces are put together in the
// bucket, so what the browser holds at any moment is one part, not the file.

export type UploadOutcome =
  | { ok: true; file: { id: string; name: string; size: number } }
  | { ok: false; errorCode: string };

type StartedUpload = { id: string; partSize: number; partCount: number };
type UploadedPart = { partNumber: number; etag: string };

// Enough to keep the connection busy while one part is being acknowledged,
// without asking the browser to hold several parts at once.
const PARTS_IN_FLIGHT = 3;
// A part that fails is worth asking for again: a long upload passes through
// more of the network than a short one, and losing a whole file to one dropped
// connection is the thing this is for.
const ATTEMPTS_PER_PART = 3;

export async function uploadStorageFile(
  file: File,
  { onProgress }: { onProgress?: (sentBytes: number) => void } = {},
): Promise<UploadOutcome> {
  const started = await fetch("/api/internal/storage/uploads", {
    method: "POST",
    headers: { "content-type": "application/json", ...INTERNAL_REQUEST_HEADERS },
    body: JSON.stringify({
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
    }),
  });
  if (!started.ok) return { ok: false, errorCode: await errorCodeOf(started) };
  const upload = (await started.json()) as StartedUpload;

  let sent = 0;
  const parts: UploadedPart[] = [];
  try {
    const numbers = Array.from({ length: upload.partCount }, (_, i) => i + 1);
    // Each worker takes the next part number, so a slow part holds up nothing
    // but itself.
    const workers = Array.from(
      { length: Math.min(PARTS_IN_FLIGHT, numbers.length) },
      async () => {
        for (;;) {
          const partNumber = numbers.shift();
          if (partNumber === undefined) return;
          const start = (partNumber - 1) * upload.partSize;
          const slice = file.slice(start, start + upload.partSize);
          const etag = await sendPart(upload.id, partNumber, slice);
          parts.push({ partNumber, etag });
          sent += slice.size;
          onProgress?.(sent);
        }
      },
    );
    await Promise.all(workers);
  } catch (error) {
    // The parts already in the bucket are of no use without the rest, and they
    // would be paid for until something threw them away.
    await fetch(`/api/internal/storage/uploads/${upload.id}`, {
      method: "DELETE",
      headers: { ...INTERNAL_REQUEST_HEADERS },
      keepalive: true,
    }).catch(() => undefined);
    return {
      ok: false,
      errorCode: error instanceof UploadPartError ? error.errorCode : "uploadFailed",
    };
  }

  const finished = await fetch(`/api/internal/storage/uploads/${upload.id}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...INTERNAL_REQUEST_HEADERS },
    body: JSON.stringify({
      // R2 joins them in the order it is given, not the order they arrived.
      parts: parts.sort((left, right) => left.partNumber - right.partNumber),
    }),
  });
  if (!finished.ok) return { ok: false, errorCode: await errorCodeOf(finished) };

  return {
    ok: true,
    file: (await finished.json()) as { id: string; name: string; size: number },
  };
}

class UploadPartError extends Error {
  constructor(readonly errorCode: string) {
    super(`The upload part was refused: ${errorCode}`);
  }
}

async function sendPart(
  uploadId: string,
  partNumber: number,
  body: Blob,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS_PER_PART; attempt++) {
    try {
      const response = await fetch(
        `/api/internal/storage/uploads/${uploadId}/parts/${partNumber}`,
        { method: "PUT", headers: { ...INTERNAL_REQUEST_HEADERS }, body },
      );
      if (response.ok) {
        return ((await response.json()) as UploadedPart).etag;
      }
      // Nothing about this part will be different next time.
      if (response.status < 500) {
        throw new UploadPartError(await errorCodeOf(response));
      }
      lastError = new UploadPartError("uploadFailed");
    } catch (error) {
      if (error instanceof UploadPartError) throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
  }
  throw lastError ?? new UploadPartError("uploadFailed");
}

async function errorCodeOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error_code?: unknown };
    return typeof body.error_code === "string" ? body.error_code : "uploadFailed";
  } catch {
    return "uploadFailed";
  }
}
