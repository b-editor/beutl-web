import "server-only";
import { STORAGE_QUOTA_BYTES, STORAGE_UPLOAD_PART_BYTES } from "@beutl/core";
import {
  createFile,
  createStorageUpload,
  deleteStorageUpload,
  findStorageFileByIdAndUserId,
  findStorageUploadByIdAndUserId,
  markStorageUploadCompleted,
  type PrismaTransaction,
  retrieveFileNamesAndSizesByUserId,
  startRetryableTransaction,
  sumFileSizeByUserId,
  sumStorageUploadSizeByUserId,
} from "@beutl/db";
import { getR2Bucket } from "@beutl/api";

// Uploading a file that one request cannot carry.
//
// Cloudflare stops a request body at 100 MB, and an upload here may be up to
// the whole quota, so a file arrives as a run of smaller requests and is put
// together in the bucket itself: R2 keeps the parts under an upload id and
// joins them when the last one has arrived. Nothing is buffered on the way —
// each part is streamed straight into the bucket — so a large file costs the
// same memory as a small one.

export type UploadFailure =
  | "fileNotFound"
  | "insufficientStorageSpace"
  | "uploadNotFound"
  | "uploadFailed";

export type StartedUpload = {
  id: string;
  partSize: number;
  partCount: number;
};

// The one way anything here reaches the bucket, which is also what lets a test
// stand in for it.
function bucket() {
  const configured = getR2Bucket();
  if (!configured.createMultipartUpload || !configured.resumeMultipartUpload) {
    throw new Error("The configured R2 bucket cannot take an upload in parts.");
  }
  return configured as Required<
    Pick<typeof configured, "createMultipartUpload" | "resumeMultipartUpload">
  > &
    typeof configured;
}

// A name of our own, never the one the file came with: an object key built from
// user input is a path the user chooses inside the bucket.
function newObjectKey(): string {
  return crypto.randomUUID();
}

// A second file of the same name becomes "clip (1).mp4" rather than replacing
// the first, which is what the screen did before an upload came in parts.
async function availableName({
  userId,
  name,
  prisma,
}: {
  userId: string;
  name: string;
  prisma?: PrismaTransaction;
}): Promise<string> {
  const taken = new Set(
    (await retrieveFileNamesAndSizesByUserId({ userId, prisma })).map(
      (file) => file.name,
    ),
  );
  if (!taken.has(name)) return name;

  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  const stem = extension ? name.slice(0, -extension.length) : name;
  for (let index = 1; ; index++) {
    const candidate = `${stem} (${index})${extension}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// What the part at this position may carry: a whole part, except the last one,
// which carries only what is left of the declared size.
function allowedPartSize(size: bigint, partSize: number, partNumber: number): bigint {
  const before = BigInt(partSize) * BigInt(partNumber - 1);
  const remaining = size - before;
  if (remaining <= BigInt(0)) return BigInt(0);
  return remaining < BigInt(partSize) ? remaining : BigInt(partSize);
}

export function partCountOf(size: bigint): number {
  if (size <= BigInt(0)) return 1;
  const parts = (size + BigInt(STORAGE_UPLOAD_PART_BYTES) - BigInt(1)) /
    BigInt(STORAGE_UPLOAD_PART_BYTES);
  return Number(parts);
}

export async function startUpload({
  userId,
  id,
  name,
  mimeType,
  size,
}: {
  userId: string;
  // 開始要求の名前。応答だけが失われても、同じ名前で問い合わせ直せば同じ
  // アップロードが返る。これが無いと、ブラウザは 24 時間ぶんの枠を握ったまま
  // 二度と手の届かないアップロードを残すことになる。
  id: string;
  name: string;
  mimeType: string;
  size: bigint;
}): Promise<{ ok: true; upload: StartedUpload } | { ok: false; reason: UploadFailure }> {
  const existing = await findStorageUploadByIdAndUserId({ id, userId });
  if (existing) {
    return existing.completedFileId
      ? { ok: false, reason: "uploadFailed" }
      : {
        ok: true,
        upload: {
          id: existing.id,
          partSize: existing.partSize,
          partCount: partCountOf(existing.size),
        },
      };
  }

  const objectKey = newObjectKey();
  const multipart = await bucket().createMultipartUpload(objectKey, {
    httpMetadata: mimeType ? { contentType: mimeType } : undefined,
  });

  let upload: Awaited<ReturnType<typeof createStorageUpload>> | null;
  try {
    // Reading the totals and writing the row that changes them is one
    // transaction. CockroachDB runs it serializably, so two uploads started at
    // the same moment cannot both read the total from before the other: one is
    // retried and sees the other's row. Read, check and write apart, they
    // would each see room for themselves and together pass the quota.
    upload = await startRetryableTransaction(async (prisma) => {
      // 名前が先に取られていたら（同時に届いた 2 本目）、それを返す。枠の計算を
      // 先にすると、同じ 1 本のアップロードを二重に数えて自分自身を弾いてしまう。
      const raced = await findStorageUploadByIdAndUserId({ id, userId, prisma });
      if (raced) return raced;

      const [stored, underway] = await Promise.all([
        sumFileSizeByUserId({ userId, prisma }),
        sumStorageUploadSizeByUserId({ userId, prisma }),
      ]);
      if (stored + underway + size > BigInt(STORAGE_QUOTA_BYTES)) {
        return null;
      }

      return await createStorageUpload({
        userId,
        id,
        objectKey,
        uploadId: multipart.uploadId,
        name: await availableName({ userId, name, prisma }),
        mimeType,
        size,
        partSize: STORAGE_UPLOAD_PART_BYTES,
        prisma,
      });
    });
  } catch (error) {
    // The bucket is already holding an upload that nothing now points at. It
    // would keep its parts, and be paid for, until something threw them away.
    await abandon(objectKey, multipart.uploadId);
    throw error;
  }

  if (!upload) {
    await abandon(objectKey, multipart.uploadId);
    return { ok: false, reason: "insufficientStorageSpace" };
  }

  return {
    ok: true,
    upload: {
      id: upload.id,
      partSize: STORAGE_UPLOAD_PART_BYTES,
      partCount: partCountOf(size),
    },
  };
}

export async function uploadPart({
  userId,
  uploadId,
  partNumber,
  contentLength,
  body,
}: {
  userId: string;
  uploadId: string;
  partNumber: number;
  contentLength: number;
  body: ReadableStream<Uint8Array>;
}): Promise<{ ok: true; etag: string } | { ok: false; reason: UploadFailure }> {
  const upload = await findStorageUploadByIdAndUserId({ id: uploadId, userId });
  if (!upload) return { ok: false, reason: "uploadNotFound" };
  if (partNumber < 1 || partNumber > partCountOf(upload.size)) {
    return { ok: false, reason: "uploadNotFound" };
  }
  // The quota was reserved against the size the upload declared. Without this,
  // an upload declaring nothing could still send parts of any length: the parts
  // are held for a day and paid for, and none of it was ever counted.
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    return { ok: false, reason: "uploadFailed" };
  }
  if (BigInt(contentLength) > allowedPartSize(upload.size, upload.partSize, partNumber)) {
    return { ok: false, reason: "insufficientStorageSpace" };
  }

  const multipart = bucket().resumeMultipartUpload(
    upload.objectKey,
    upload.uploadId,
  );
  // Handed on exactly as it arrived. The bucket takes a stream only when it can
  // know its length, which the request body carries and a stream wrapped around
  // it would not — reading the part into memory to give it one would defeat the
  // point of splitting the file up at all.
  const part = await multipart.uploadPart(partNumber, body);
  return { ok: true, etag: part.etag };
}

export async function finishUpload({
  userId,
  uploadId,
  parts,
}: {
  userId: string;
  uploadId: string;
  parts: { partNumber: number; etag: string }[];
}): Promise<
  | { ok: true; file: { id: string; name: string; size: bigint } }
  | { ok: false; reason: UploadFailure }
> {
  const upload = await findStorageUploadByIdAndUserId({ id: uploadId, userId });
  if (!upload) return { ok: false, reason: "uploadNotFound" };

  // Finished already. Only the answer went missing, so it is given again rather
  // than the whole file being asked for a second time — which would store the
  // same bytes twice and spend the quota twice.
  if (upload.completedFileId) {
    const file = await findStorageFileByIdAndUserId({
      id: upload.completedFileId,
      userId,
    });
    if (!file) return { ok: false, reason: "fileNotFound" };
    return {
      ok: true,
      file: { id: file.id, name: file.name, size: BigInt(file.size) },
    };
  }

  const multipart = bucket().resumeMultipartUpload(
    upload.objectKey,
    upload.uploadId,
  );
  let object: { size: number };
  try {
    object = await multipart.complete(parts);
  } catch {
    // Another completion of the same upload may have joined the parts already,
    // in which case the bucket no longer knows this upload id. Its file is the
    // answer, and neither the object nor the row is this call's to remove.
    const settled = await completedFileOf(upload.id, userId);
    if (settled.kind === "completed") return { ok: true, file: settled.file };
    if (settled.kind === "unknown") return { ok: false, reason: "uploadFailed" };

    // A part that never arrived, or one the bucket does not recognise. The
    // upload keeps its parts until it is abandoned, so it is abandoned here —
    // and the row is kept when that did not work, so a later sweep can try
    // again rather than losing the parts for good.
    if (await abandon(upload.objectKey, upload.uploadId)) {
      await deleteStorageUpload({ id: upload.id });
    }

    return { ok: false, reason: "uploadFailed" };
  }

  // The size the browser declared is what the quota was checked against; this
  // is what actually arrived, and it is what the quota is held to. The check,
  // the file and the receipt naming it are one transaction: written apart, a
  // failure between them leaves a stored file nothing can hand back, and two
  // completions arriving together each store the same bytes.
  const actual = BigInt(object.size);
  let outcome:
    | { kind: "created"; id: string; name: string }
    | { kind: "alreadyCompleted"; fileId: string }
    | { kind: "overQuota" }
    | { kind: "gone" };
  try {
    outcome = await startRetryableTransaction(async (prisma) => {
      const current = await findStorageUploadByIdAndUserId({
        id: upload.id,
        userId,
        prisma,
      });
      if (!current) return { kind: "gone" as const };
      if (current.completedFileId) {
        return {
          kind: "alreadyCompleted" as const,
          fileId: current.completedFileId,
        };
      }

      const stored = await sumFileSizeByUserId({ userId, prisma });
      if (stored + actual > BigInt(STORAGE_QUOTA_BYTES)) {
        return { kind: "overQuota" as const };
      }

      const created = await createFile({
        objectKey: upload.objectKey,
        name: upload.name,
        size: Number(actual),
        mimeType: upload.mimeType,
        userId,
        visibility: "PRIVATE",
        prisma,
      });
      // The row stays as the receipt of a finished upload. Its size is no
      // longer counted as under way, and the sweep clears the receipt later.
      await markStorageUploadCompleted({
        id: upload.id,
        fileId: created.id,
        prisma,
      });
      return { kind: "created" as const, id: created.id, name: created.name };
    });
  } catch (error) {
    // A failure reported after the commit landed is indistinguishable from one
    // reported before it, so the receipt is what decides: if it is there, a
    // file points at this object and removing it would destroy a stored file.
    const settled = await completedFileOf(upload.id, userId);
    if (settled.kind === "completed") return { ok: true, file: settled.file };
    // 読めなかったときは消さない。File が指しているかもしれないオブジェクトを
    // 消すのは取り返しがつかない。掃除は sweeper に任せる。
    if (settled.kind === "unknown") throw error;

    // Nothing points at the object: it would be stored, and paid for, without
    // ever being seen again. The tracking row is left alone — a transaction
    // that rolled back wrote no receipt, so the sweep can still find the upload
    // and clear it.
    try {
      await bucket().delete?.(upload.objectKey);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "The upload failed and its object could not be cleaned up",
      );
    }
    throw error;
  }

  if (outcome.kind === "gone") return { ok: false, reason: "uploadNotFound" };

  if (outcome.kind === "overQuota") {
    await bucket().delete?.(upload.objectKey);
    await deleteStorageUpload({ id: upload.id });
    return { ok: false, reason: "insufficientStorageSpace" };
  }

  if (outcome.kind === "alreadyCompleted") {
    // Another completion of the same upload got there first. Its file is the
    // answer; the object it points at is not this call's to remove.
    const settled = await completedFileOf(upload.id, userId);
    return settled.kind === "completed"
      ? { ok: true, file: settled.file }
      : { ok: false, reason: "fileNotFound" };
  }

  return { ok: true, file: { id: outcome.id, name: outcome.name, size: actual } };
}

export async function cancelUpload({
  userId,
  uploadId,
}: {
  userId: string;
  uploadId: string;
}): Promise<boolean> {
  const upload = await findStorageUploadByIdAndUserId({ id: uploadId, userId });
  if (!upload) return false;

  // A finished upload has no parts left to throw away, and its file is not
  // this call's to delete.
  if (upload.completedFileId) {
    await deleteStorageUpload({ id: upload.id });
    return true;
  }

  // The row is only dropped once the parts are known to be gone. Dropping it
  // after a failed abort leaves parts nothing knows about, which the sweep can
  // then never find. The caller is told the upload is cancelled either way —
  // it is, as far as this account is concerned — and the sweep finishes the job.
  if (await abandon(upload.objectKey, upload.uploadId)) {
    await deleteStorageUpload({ id: upload.id });
  }

  return true;
}

// Whether the parts are gone. A failure here is usually "already gone", but it
// can be the bucket being briefly unreachable, and the two are told apart by
// the caller: the tracking row is what lets a later sweep try again, so it is
// kept while an abort has not been seen to work.
// The file a completed upload made, when its receipt has been written. Read
// wherever a failure could be either "it did not happen" or "it happened and
// the answer went missing".
type CompletionReceipt =
  | { kind: "completed"; file: { id: string; name: string; size: bigint } }
  | { kind: "none" }
  // 読めなかった。「レシートが無い」とは違う——ここで取り違えると、実際には
  // File が指しているオブジェクトを消してしまう。
  | { kind: "unknown" };

async function completedFileOf(
  uploadId: string,
  userId: string,
): Promise<CompletionReceipt> {
  let current;
  try {
    current = await findStorageUploadByIdAndUserId({ id: uploadId, userId });
  } catch (error) {
    console.error("Failed to read a storage upload receipt", uploadId, error);
    return { kind: "unknown" };
  }

  if (!current) return { kind: "none" };
  if (!current.completedFileId) return { kind: "none" };

  let file;
  try {
    file = await findStorageFileByIdAndUserId({
      id: current.completedFileId,
      userId,
    });
  } catch (error) {
    console.error("Failed to read a completed upload's file", uploadId, error);
    return { kind: "unknown" };
  }

  if (!file) return { kind: "none" };
  return {
    kind: "completed",
    file: { id: file.id, name: file.name, size: BigInt(file.size) },
  };
}

async function abandon(objectKey: string, uploadId: string): Promise<boolean> {
  try {
    await bucket().resumeMultipartUpload(objectKey, uploadId).abort();
    return true;
  } catch (error) {
    console.error("Failed to abandon a storage upload", error);
    return false;
  }
}
