import "server-only";
import { STORAGE_QUOTA_BYTES, STORAGE_UPLOAD_PART_BYTES } from "@beutl/core";
import {
  createFile,
  createStorageUpload,
  deleteStorageUpload,
  findStorageUploadByIdAndUserId,
  retrieveFileNamesAndSizesByUserId,
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
}: {
  userId: string;
  name: string;
}): Promise<string> {
  const taken = new Set(
    (await retrieveFileNamesAndSizesByUserId({ userId })).map(
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

export function partCountOf(size: bigint): number {
  if (size <= BigInt(0)) return 1;
  const parts = (size + BigInt(STORAGE_UPLOAD_PART_BYTES) - BigInt(1)) /
    BigInt(STORAGE_UPLOAD_PART_BYTES);
  return Number(parts);
}

export async function startUpload({
  userId,
  name,
  mimeType,
  size,
}: {
  userId: string;
  name: string;
  mimeType: string;
  size: bigint;
}): Promise<{ ok: true; upload: StartedUpload } | { ok: false; reason: UploadFailure }> {
  // What is stored plus what is already on its way. Two uploads started at once
  // would otherwise each see only the stored total and together pass the quota.
  const [stored, underway] = await Promise.all([
    sumFileSizeByUserId({ userId }),
    sumStorageUploadSizeByUserId({ userId }),
  ]);
  if (stored + underway + size > BigInt(STORAGE_QUOTA_BYTES)) {
    return { ok: false, reason: "insufficientStorageSpace" };
  }

  const objectKey = newObjectKey();
  const multipart = await bucket().createMultipartUpload(objectKey, {
    httpMetadata: mimeType ? { contentType: mimeType } : undefined,
  });
  const upload = await createStorageUpload({
    userId,
    objectKey,
    uploadId: multipart.uploadId,
    name: await availableName({ userId, name }),
    mimeType,
    size,
    partSize: STORAGE_UPLOAD_PART_BYTES,
  });

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
  body,
}: {
  userId: string;
  uploadId: string;
  partNumber: number;
  body: ReadableStream<Uint8Array>;
}): Promise<{ ok: true; etag: string } | { ok: false; reason: UploadFailure }> {
  const upload = await findStorageUploadByIdAndUserId({ id: uploadId, userId });
  if (!upload) return { ok: false, reason: "uploadNotFound" };
  if (partNumber < 1 || partNumber > partCountOf(upload.size)) {
    return { ok: false, reason: "uploadNotFound" };
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

  const multipart = bucket().resumeMultipartUpload(
    upload.objectKey,
    upload.uploadId,
  );
  let object: { size: number };
  try {
    object = await multipart.complete(parts);
  } catch {
    // A part that never arrived, or one the bucket does not recognise. The
    // upload keeps its parts until it is abandoned, so it is abandoned here.
    await abandon(upload.objectKey, upload.uploadId);
    await deleteStorageUpload({ id: upload.id });
    return { ok: false, reason: "uploadFailed" };
  }

  // The size the browser declared is what the quota was checked against; this
  // is what actually arrived, and it is what the quota is held to.
  const actual = BigInt(object.size);
  const stored = await sumFileSizeByUserId({ userId });
  if (stored + actual > BigInt(STORAGE_QUOTA_BYTES)) {
    await bucket().delete?.(upload.objectKey);
    await deleteStorageUpload({ id: upload.id });
    return { ok: false, reason: "insufficientStorageSpace" };
  }

  let file;
  try {
    file = await createFile({
      objectKey: upload.objectKey,
      name: upload.name,
      size: Number(actual),
      mimeType: upload.mimeType,
      userId,
      visibility: "PRIVATE",
    });
  } catch (error) {
    // The object is in the bucket and nothing points at it: it would be stored,
    // and paid for, without ever being seen again.
    try {
      await bucket().delete?.(upload.objectKey);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "The upload failed and its object could not be cleaned up",
      );
    } finally {
      await deleteStorageUpload({ id: upload.id }).catch(() => undefined);
    }
    throw error;
  }

  await deleteStorageUpload({ id: upload.id });
  return { ok: true, file: { id: file.id, name: file.name, size: actual } };
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

  await abandon(upload.objectKey, upload.uploadId);
  await deleteStorageUpload({ id: upload.id });
  return true;
}

async function abandon(objectKey: string, uploadId: string): Promise<void> {
  try {
    await bucket().resumeMultipartUpload(objectKey, uploadId).abort();
  } catch (error) {
    // Already gone, or never there. The row goes either way; what must not
    // happen is a failed abort keeping the row and the parts alive forever.
    console.error("Failed to abandon a storage upload", error);
  }
}
