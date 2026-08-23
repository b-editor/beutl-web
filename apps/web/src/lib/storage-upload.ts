import { randomUuid } from "@beutl/core";
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

// 取り消しは一度きりでは足りない。バケットが中止を受け付けないことがあり、そこ
// で手を引くとこの名前の枠が一日残る。間を置いて数回だけ試す——それでも駄目なら
// 掃除がいずれ拾う。行がまだ現れていないときは、サーバー側が墓標を置いて
// 「取り消せた」と答えるので、一度で済む。
const CANCEL_ATTEMPTS = 3;
const CANCEL_RETRY_MILLISECONDS = 400;

async function cancelUpload(id: string): Promise<void> {
  for (let attempt = 0; attempt < CANCEL_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, CANCEL_RETRY_MILLISECONDS * attempt),
      );
    }

    try {
      const response = await fetch(`/api/internal/storage/uploads/${id}`, {
        method: "DELETE",
        headers: { ...INTERNAL_REQUEST_HEADERS },
        keepalive: true,
      });
      // 204 だけが「片付いた」。404 はまだ現れていないだけかもしれず、503 は
      // バケットにまだ残っているということ。
      if (response.status === 204) return;
    } catch {
      // 次で試す。
    }
  }
}

export async function uploadStorageFile(
  file: File,
  { onProgress }: { onProgress?: (sentBytes: number) => void } = {},
): Promise<UploadOutcome> {
  // The upload is named before it is asked for, so an answer lost on the way
  // back can be asked for again and comes back as the same upload. Without
  // that, the browser loses the id every later request names and the upload it
  // made holds a day's worth of quota nothing can reach.
  const id = randomUuid();
  const startBody = JSON.stringify({
    id,
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
  });
  let started: Response;
  try {
    started = await postStart(startBody);
  } catch {
    try {
      started = await postStart(startBody);
    } catch {
      // 二度とも答えが返らなかった。始まっていないとは限らない——この名前で
      // 始まっているなら、宣言した大きさぶんの枠を一日抱えたまま誰も手が
      // 届かなくなる。手放す前に、その名前で取り消しておく。
      await cancelUpload(id);
      return { ok: false, errorCode: "uploadFailed" };
    }
  }
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
    await cancelUpload(upload.id);
    return {
      ok: false,
      errorCode: error instanceof UploadPartError ? error.errorCode : "uploadFailed",
    };
  }

  // R2 joins them in the order it is given, not the order they arrived.
  const body = JSON.stringify({
    parts: parts.sort((left, right) => left.partNumber - right.partNumber),
  });
  // Asking twice is safe: the server keeps a receipt of a finished upload and
  // answers a repeat with the file it already made. Without the retry, an
  // answer lost on the way back leaves the browser unable to tell whether the
  // file exists, and starting over stores the same bytes a second time.
  let finished: Response;
  try {
    finished = await postCompletion(upload.id, body);
  } catch {
    try {
      finished = await postCompletion(upload.id, body);
    } catch {
      return { ok: false, errorCode: "uploadFailed" };
    }
  }
  if (!finished.ok) return { ok: false, errorCode: await errorCodeOf(finished) };

  return {
    ok: true,
    file: (await finished.json()) as { id: string; name: string; size: number },
  };
}

function postStart(body: string): Promise<Response> {
  return fetch("/api/internal/storage/uploads", {
    method: "POST",
    headers: { "content-type": "application/json", ...INTERNAL_REQUEST_HEADERS },
    body,
  });
}

function postCompletion(uploadId: string, body: string): Promise<Response> {
  return fetch(`/api/internal/storage/uploads/${uploadId}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...INTERNAL_REQUEST_HEADERS },
    body,
  });
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
