import { randomUuid } from "@beutl/core";
import { INTERNAL_REQUEST_HEADERS } from "./internal-request";

// Sending a file that one request cannot carry.
//
// The file is cut into parts and each part is sent on its own, because the
// platform stops a request body at 100 MB. The pieces are put together in the
// bucket, so what the browser holds at any moment is one part, not the file.

export type UploadOutcome =
  | { ok: true; file: { id: string; name: string; size: number } }
  | {
      ok: false;
      errorCode: string;
      pendingCompletion?: PendingStorageUploadCompletion;
    };

type StartedUpload = { id: string; partSize: number; partCount: number };
type UploadedPart = { partNumber: number; etag: string };
/** The only durable state needed to ask a committed upload for its receipt. */
export type PendingStorageUploadCompletion = Readonly<{
  uploadId: string;
  body: string;
  ownerId: string;
}>;

export const PENDING_STORAGE_UPLOADS_KEY =
  "beutl.storage-upload-completions.v1";

export type StorageUploadLock = { current: boolean };

export function tryAcquireStorageUploadLock(lock: StorageUploadLock): boolean {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function releaseStorageUploadLock(lock: StorageUploadLock): void {
  lock.current = false;
}

export async function withStorageUploadLock<T>(
  lock: StorageUploadLock,
  action: () => Promise<T>,
): Promise<T | undefined> {
  if (!tryAcquireStorageUploadLock(lock)) return undefined;
  try {
    return await action();
  } finally {
    releaseStorageUploadLock(lock);
  }
}

const TERMINAL_COMPLETION_ERRORS = new Set([
  "invalidRequestBody",
  "uploadNotFound",
  "fileNotFound",
  "insufficientStorageSpace",
  "tooManyFiles",
  "tooManyUploads",
]);

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem"> & {
  length?: number;
  key?: (index: number) => string | null;
};

function browserStore(name: "localStorage" | "sessionStorage"): StorageLike | null {
  try {
    return typeof globalThis[name] === "undefined" ? null : globalThis[name];
  } catch {
    return null;
  }
}

function persistentStore(): StorageLike | null {
  return browserStore("localStorage") ?? browserStore("sessionStorage");
}

function sessionStore(): StorageLike | null {
  return browserStore("sessionStorage");
}

function completionKey(uploadId: string, ownerId: string): string {
  return `${PENDING_STORAGE_UPLOADS_KEY}:${encodeURIComponent(ownerId)}:${uploadId}`;
}

function validPending(value: unknown): value is PendingStorageUploadCompletion {
  return !!value && typeof value === "object" &&
    typeof (value as { uploadId?: unknown }).uploadId === "string" &&
    typeof (value as { body?: unknown }).body === "string" &&
    typeof (value as { ownerId?: unknown }).ownerId === "string" &&
    (value as { ownerId: string }).ownerId.length > 0;
}

function isCompletedStorageFile(
  value: unknown,
): value is { id: string; name: string; size: number } {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  return typeof result.id === "string" && result.id.length > 0 &&
    typeof result.name === "string" && result.name.length > 0 &&
    typeof result.size === "number" && Number.isSafeInteger(result.size) &&
    result.size >= 0;
}

function loadFromStorage(
  storage: StorageLike | null,
): PendingStorageUploadCompletion[] {
  if (!storage) return [];
  try {
    const byId = new Map<string, PendingStorageUploadCompletion>();
    if (storage.key && typeof storage.length === "number") {
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (!key?.startsWith(`${PENDING_STORAGE_UPLOADS_KEY}:`)) continue;
        try {
          const value = JSON.parse(storage.getItem(key) ?? "null");
          if (validPending(value)) byId.set(value.uploadId, value);
        } catch {
          // One corrupt receipt must not hide the other owner-scoped receipts.
        }
      }
    }
    return [...byId.values()];
  } catch {
    return [];
  }
}

export function loadPendingStorageUploadCompletions(
  ownerId: string,
  storage?: StorageLike | null,
): PendingStorageUploadCompletion[] {
  if (storage !== undefined) {
    return loadFromStorage(storage).filter((entry) => entry.ownerId === ownerId);
  }
  // localStorage is the authoritative primary when it is available. Do not
  // let the session fallback overwrite a newer local receipt for the same id.
  const primary = browserStore("localStorage");
  const secondary = sessionStore();
  const byId = new Map<string, PendingStorageUploadCompletion>();
  for (const value of loadFromStorage(primary)) {
    if (value.ownerId === ownerId) byId.set(value.uploadId, value);
  }
  if (secondary && secondary !== primary) {
    for (const value of loadFromStorage(secondary)) {
      if (value.ownerId === ownerId && !byId.has(value.uploadId)) {
        byId.set(value.uploadId, value);
      }
    }
  }
  return [...byId.values()];
}

export function persistPendingStorageUploadCompletion(
  pending: PendingStorageUploadCompletion,
  storage?: StorageLike | null,
): boolean {
  const stores = storage === undefined
    ? [browserStore("localStorage"), sessionStore()]
    : [storage];
  const seen = new Set<StorageLike>();
  const key = completionKey(pending.uploadId, pending.ownerId);
  for (const [index, current] of stores.entries()) {
    if (!current || seen.has(current)) continue;
    seen.add(current);
    // One key per receipt makes concurrent tabs independent: no read-modify-
    // write of a shared queue can erase another tab's handle.
    try {
      current.setItem(
        key,
        JSON.stringify(pending),
      );
      // Once localStorage recovers, remove the stale session copy so future
      // fallback reads cannot retain an older body indefinitely.
      if (storage === undefined && index === 0) {
        const session = sessionStore();
        if (session && session !== current) {
          try {
            session.removeItem(key);
          } catch {
            // Best effort cleanup; localStorage remains authoritative.
          }
        }
      }
      return true;
    } catch {
      // Try the next durable browser store before giving up.
    }
  }
  return false;
}

export function discardPendingStorageUploadCompletion(
  uploadId: string,
  ownerId: string,
  storage?: StorageLike | null,
): void {
  const stores = storage === undefined
    ? [persistentStore(), sessionStore()]
    : [storage];
  for (const current of stores) {
    if (!current) continue;
    try {
      current.removeItem(completionKey(uploadId, ownerId));
    } catch {
      // The receipt may still be swept by the server if storage is unavailable.
    }
  }
}

// Enough to keep the connection busy while one part is being acknowledged,
// without asking the browser to hold several parts at once.
const PARTS_IN_FLIGHT = 3;
// A part that fails is worth asking for again: a long upload passes through
// more of the network than a short one, and losing a whole file to one dropped
// connection is the thing this is for.
const ATTEMPTS_PER_PART = 3;
// 完了を伝える回。サーバーは終わったアップロードの控えを持っていて、同じ id で
// もう一度聞かれれば作ったファイルをそのまま返す——だから何度でも聞ける。
// 聞くのをやめると、ブラウザにはファイルが出来たかどうかを知る手立てが無くなり、
// やり直しは同じ中身をもう一つ作る。
const COMPLETION_ATTEMPTS = 4;
const COMPLETION_RETRY_MILLISECONDS = 500;
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
  { onProgress, ownerId }: { onProgress?: (sentBytes: number) => void; ownerId: string },
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
  // A start succeeds only after a non-5xx response and valid JSON are read.
  // Retry either an error response or an unreadable response under the same id.
  let upload: StartedUpload | null = null;
  for (let attempt = 1; attempt <= COMPLETION_ATTEMPTS; attempt++) {
    let started: Response;
    try {
      started = await postStart(startBody);
    } catch {
      if (attempt === COMPLETION_ATTEMPTS) {
        // The start may have succeeded even without a response. Cancel by the
        // same id before releasing the reserved quota.
        await cancelUpload(id);
        return { ok: false, errorCode: "uploadFailed" };
      }
      await new Promise((resolve) =>
        setTimeout(resolve, COMPLETION_RETRY_MILLISECONDS * attempt),
      );
      continue;
    }
    if (started.status >= 500) {
      if (attempt === COMPLETION_ATTEMPTS) {
        await cancelUpload(id);
        return { ok: false, errorCode: "uploadFailed" };
      }
      await new Promise((resolve) =>
        setTimeout(resolve, COMPLETION_RETRY_MILLISECONDS * attempt),
      );
      continue;
    }
    if (!started.ok) {
      return { ok: false, errorCode: await errorCodeOf(started) };
    }
    try {
      upload = (await started.json()) as StartedUpload;
      break;
    } catch {
      if (attempt === COMPLETION_ATTEMPTS) {
        await cancelUpload(id);
        return { ok: false, errorCode: "uploadFailed" };
      }
      await new Promise((resolve) =>
        setTimeout(resolve, COMPLETION_RETRY_MILLISECONDS * attempt),
      );
    }
  }
  if (!upload) {
    await cancelUpload(id);
    return { ok: false, errorCode: "uploadFailed" };
  }

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
  if (!ownerId) {
    throw new Error("Storage upload completion requires an owner identity");
  }
  const completion = { uploadId: upload.id, body, ownerId };
  persistPendingStorageUploadCompletion(completion);
  return resumeStorageUploadCompletion(completion);
}

export async function resumeStorageUploadCompletion(
  pending: PendingStorageUploadCompletion,
): Promise<UploadOutcome> {
  // A completion response can be committed while its response is lost. Do not
  // make that irreversible request unless the opaque handle is durable in at
  // least one browser store; otherwise a reload would force a new upload id.
  if (!persistPendingStorageUploadCompletion(pending)) {
    return { ok: false, errorCode: "storagePersistenceUnavailable", pendingCompletion: pending };
  }
  for (let attempt = 1; attempt <= COMPLETION_ATTEMPTS; attempt++) {
    let finished: Response;
    try {
      finished = await postCompletion(pending.uploadId, pending.body);
    } catch {
      if (attempt === COMPLETION_ATTEMPTS) {
        return {
          ok: false,
          errorCode: "uploadFailed",
          pendingCompletion: pending,
        };
      }
      await new Promise((resolve) =>
        setTimeout(resolve, COMPLETION_RETRY_MILLISECONDS * attempt),
      );
      continue;
    }
    if (finished.status >= 500) {
      if (attempt === COMPLETION_ATTEMPTS) {
        return {
          ok: false,
          errorCode: "uploadFailed",
          pendingCompletion: pending,
        };
      }
      await new Promise((resolve) =>
        setTimeout(resolve, COMPLETION_RETRY_MILLISECONDS * attempt),
      );
      continue;
    }
    if (!finished.ok) {
      const errorCode = await errorCodeOf(finished);
      if (!TERMINAL_COMPLETION_ERRORS.has(errorCode)) {
        return { ok: false, errorCode, pendingCompletion: pending };
      }
      discardPendingStorageUploadCompletion(pending.uploadId, pending.ownerId);
      return { ok: false, errorCode };
    }
    try {
      const result: unknown = await finished.json();
      if (!isCompletedStorageFile(result)) throw new Error("Invalid storage upload completion");
      discardPendingStorageUploadCompletion(pending.uploadId, pending.ownerId);
      return { ok: true, file: result };
    } catch {
      if (attempt === COMPLETION_ATTEMPTS) {
        return {
          ok: false,
          errorCode: "uploadFailed",
          pendingCompletion: pending,
        };
      }
      await new Promise((resolve) =>
        setTimeout(resolve, COMPLETION_RETRY_MILLISECONDS * attempt),
      );
    }
  }
  return {
    ok: false,
    errorCode: "uploadFailed",
    pendingCompletion: pending,
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

export function isTerminalStorageUploadError(errorCode: string): boolean {
  return TERMINAL_COMPLETION_ERRORS.has(errorCode);
}
