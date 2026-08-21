import "server-only";
import {
  STORAGE_FILE_COUNT_LIMIT,
  STORAGE_QUOTA_BYTES,
  STORAGE_UPLOAD_PART_BYTES,
} from "@beutl/core";
import {
  claimStorageUploadForAbandon,
  countFilesByUserId,
  createFile,
  countStorageUploadsByUserId,
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

// 一度に抱えられる、まだ終わっていないアップロードの本数。大きなファイルを
// 数本並行して送るには足り、放置された handle を積み上げるには足りない。
const MAX_ACTIVE_UPLOADS = 16;

export type UploadFailure =
  | "fileNotFound"
  | "tooManyFiles"
  | "tooManyUploads"
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
    // 完了しているか、掃除に取られているか。どちらもこの名前ではもう続けられ
    // ない——取られた行のパートはもう捨てられている。
    return existing.completedFileId || existing.abandonedAt
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

  let upload:
    | Awaited<ReturnType<typeof createStorageUpload>>
    | null
    | "tooMany"
    | "tooManyFiles";
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

      // 小さなアップロードは枠をほとんど使わないので、大きさだけでは歯止めに
      // ならない。同時に抱えられる本数そのものを限る。
      const active = await countStorageUploadsByUserId({ userId, prisma });
      if (active >= MAX_ACTIVE_UPLOADS) return "tooMany";

      // 本数の上限。容量の枠内でも、小さなファイルを積み上げれば R2 の
      // オブジェクトと行はいくらでも増える。完成した本数と、いま進行中の本数を
      // 合わせて数える。
      const files = await countFilesByUserId({ userId, prisma });
      if (files + active >= STORAGE_FILE_COUNT_LIMIT) return "tooManyFiles";

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
    await abandonOrRecord({ userId, objectKey, multipart, name, mimeType });
    throw error;
  }

  if (upload === "tooMany") {
    await abandonOrRecord({ userId, objectKey, multipart, name, mimeType });
    return { ok: false, reason: "tooManyUploads" };
  }

  if (upload === "tooManyFiles") {
    await abandonOrRecord({ userId, objectKey, multipart, name, mimeType });
    return { ok: false, reason: "tooManyFiles" };
  }

  if (!upload) {
    await abandonOrRecord({ userId, objectKey, multipart, name, mimeType });
    return { ok: false, reason: "insufficientStorageSpace" };
  }

  // 同じ名前の要求が同時に届いたとき、行を書けたのは片方だけ。負けたほうが
  // 作ったマルチパートは誰も知らないままパートを抱えるので、ここで捨てる。
  if (upload.uploadId !== multipart.uploadId) {
    await abandonOrRecord({ userId, objectKey, multipart, name, mimeType });
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
  // 掃除に取られた行のパートはもう捨てられている。送っても行き先がない。
  if (upload.abandonedAt) return { ok: false, reason: "uploadNotFound" };
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

type TrackedUpload = NonNullable<
  Awaited<ReturnType<typeof findStorageUploadByIdAndUserId>>
>;

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

  // 掃除がこの行を取っている。パートも、組み上がっていたオブジェクトも、もう
  // 掃除のもの。ここで仕上げると、消される予定のオブジェクトを File が指す。
  if (upload.abandonedAt) return { ok: false, reason: "uploadFailed" };

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

    // 控えは無いのに、アップロード id は知られていない。組み上げは終わったのに
    // その直後に落ちた、という形がこれになる。R2 は結合済みのアップロードを
    // 忘れるので、中止も組み直しもできない——オブジェクトが在るかどうかだけが
    // 見分けになる。在るならこの呼び出しが仕上げる。やり直すたびに同じところで
    // 落ちて、24 時間後に掃除がそのオブジェクトを消すのでは、送った側は何度
    // 送っても届かない。
    const joined = await joinedObjectSize(upload.objectKey);
    if (joined !== null) return await finalizeUpload(upload, userId, BigInt(joined));

    // A part that never arrived, or one the bucket does not recognise. The
    // upload keeps its parts until it is abandoned, so it is abandoned here —
    // and the row is kept when that did not work, so a later sweep can try
    // again rather than losing the parts for good.
    if (await abandon(upload.objectKey, upload.uploadId)) {
      await deleteStorageUpload({ id: upload.id });
    }

    return { ok: false, reason: "uploadFailed" };
  }

  return await finalizeUpload(upload, userId, BigInt(object.size));
}

// The size the browser declared is what the quota was checked against; `actual`
// is what the bucket ended up holding, and it is what the quota is held to. The
// check, the file and the receipt naming it are one transaction: written apart,
// a failure between them leaves a stored file nothing can hand back, and two
// completions arriving together each store the same bytes.
async function finalizeUpload(
  upload: TrackedUpload,
  userId: string,
  actual: bigint,
): Promise<
  | { ok: true; file: { id: string; name: string; size: bigint } }
  | { ok: false; reason: UploadFailure }
> {
  let outcome:
    | { kind: "created"; id: string; name: string }
    | { kind: "alreadyCompleted"; fileId: string }
    | { kind: "overQuota" }
    | { kind: "tooManyFiles" }
    | { kind: "abandoned" }
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
      // 掃除が取っていった行。控えは書けないし、書いてはいけない。
      if (current.abandonedAt) return { kind: "abandoned" as const };

      const [stored, files] = await Promise.all([
        sumFileSizeByUserId({ userId, prisma }),
        countFilesByUserId({ userId, prisma }),
      ]);
      if (stored + actual > BigInt(STORAGE_QUOTA_BYTES)) {
        return { kind: "overQuota" as const };
      }
      if (files >= STORAGE_FILE_COUNT_LIMIT) {
        return { kind: "tooManyFiles" as const };
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
      // 取られていれば書けない——その場合はこの取引ごと巻き戻す。
      if (
        !await markStorageUploadCompleted({
          id: upload.id,
          fileId: created.id,
          prisma,
        })
      ) {
        throw new UploadWasAbandoned();
      }
      return { kind: "created" as const, id: created.id, name: created.name };
    });
  } catch (error) {
    if (error instanceof UploadWasAbandoned) {
      // 掃除のものになったオブジェクトを、こちらでも片付けておく。残していても
      // 次の掃除が拾うが、そのぶん保管され続ける。
      await bucket().delete?.(upload.objectKey).catch(() => undefined);
      return { ok: false, reason: "uploadFailed" };
    }

    // A failure reported after the commit landed is indistinguishable from one
    // reported before it, so the row is what decides. Reading it is not enough:
    // another completion of the same upload may be in a transaction that has
    // not committed yet, and deleting the object on the strength of "no receipt
    // yet" would leave the file it is about to record pointing at nothing.
    // Claiming the row settles it — a claimed row can never take a receipt, so
    // whatever is in the bucket is this call's to remove.
    if (!await claimForCleanup(upload.id, userId)) {
      const settled = await completedFileOf(upload.id, userId);
      if (settled.kind === "completed") return { ok: true, file: settled.file };
      // 取れず、控えも読めない。File が指しているかもしれないオブジェクトを
      // 消すのは取り返しがつかないので、掃除に任せる。
      throw error;
    }

    // Nothing points at the object, and nothing ever can: it would be stored,
    // and paid for, without ever being seen again.
    try {
      await bucket().delete?.(upload.objectKey);
    } catch (cleanupError) {
      // 消せなかった。行は残す——sweeper がもう一度試せる唯一の手掛かりなので。
      throw new AggregateError(
        [error, cleanupError],
        "The upload failed and its object could not be cleaned up",
      );
    }

    // 消せたなら片付けるものはもう無い。行を残しても、宣言された大きさで枠を
    // 押さえ続けるだけになる。
    await deleteStorageUpload({ id: upload.id }).catch(() => undefined);
    throw error;
  }

  if (outcome.kind === "gone") return { ok: false, reason: "uploadNotFound" };
  if (outcome.kind === "abandoned") {
    await bucket().delete?.(upload.objectKey).catch(() => undefined);
    return { ok: false, reason: "uploadFailed" };
  }

  if (outcome.kind === "overQuota" || outcome.kind === "tooManyFiles") {
    // 断ったのはこの呼び出しだが、同じアップロードを仕上げようとしている別の
    // 呼び出しがいるかもしれない。行を取れたときだけ消す。
    if (await claimForCleanup(upload.id, userId)) {
      await bucket().delete?.(upload.objectKey);
      await deleteStorageUpload({ id: upload.id });
    }
    return {
      ok: false,
      reason: outcome.kind === "overQuota"
        ? "insufficientStorageSpace"
        : "tooManyFiles",
    };
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

// 取引を巻き戻すためだけの合図。掃除に行を取られたので、File を作らずに戻る。
class UploadWasAbandoned extends Error {}

// 結合済みのオブジェクトの大きさ。無いとき、および確かめられないときは null。
// 確かめられないまま「在る」と読むと、届いていないものを File にしてしまう。
async function joinedObjectSize(objectKey: string): Promise<number | null> {
  try {
    const head = bucket().head;
    if (!head) return null;
    const object = await head(objectKey);
    // 大きさを言わない head もある。大きさが分からないままでは File を作れない。
    return typeof object?.size === "number" ? object.size : null;
  } catch (error) {
    console.error("Failed to look for a joined upload object", objectKey, error);
    return null;
  }
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

  // 取れなければ、そのアップロードは完了したか、掃除のものになったか。どちらも
  // ここで捨てるものではない。呼び出し側には取り消せたと答える——この利用者から
  // 見れば、もう進行中のアップロードではないので。
  if (!await claimForCleanup(upload.id, userId)) return true;

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

// 「この行のパートとオブジェクトは自分が捨てる」と宣言する。取れた行にはもう
// 控えを書けないので、そのあと何を消しても File が消えたものを指すことはない。
// 完了済み・宣言済みの行は取れない。
async function claimForCleanup(
  uploadId: string,
  userId: string,
): Promise<boolean> {
  try {
    return await claimStorageUploadForAbandon({
      id: uploadId,
      userId,
      now: new Date(),
    });
  } catch (error) {
    console.error("Failed to claim a storage upload for cleanup", uploadId, error);
    return false;
  }
}

// 誰も指していないマルチパートを捨てる。捨てられなかったときは、掃除が見つけ
// られる場所に書き留める——行の無いマルチパートは、どこからも辿れないままパート
// を抱え続け、バケット自身の期限だけが頼りになる。
async function abandonOrRecord({
  userId,
  objectKey,
  multipart,
  name,
  mimeType,
}: {
  userId: string;
  objectKey: string;
  multipart: { uploadId: string };
  name: string;
  mimeType: string;
}): Promise<void> {
  if (await abandon(objectKey, multipart.uploadId)) return;

  try {
    // 最初から掃除のものとして置く。宣言済みなので控えは書けず、抱えている
    // 大きさも分からないので枠には数えない——数えるべきものは、この行が指す
    // パートが実際に消えるまで分からない。
    await createStorageUpload({
      userId,
      id: crypto.randomUUID(),
      objectKey,
      uploadId: multipart.uploadId,
      name,
      mimeType,
      size: BigInt(0),
      partSize: STORAGE_UPLOAD_PART_BYTES,
      abandonedAt: new Date(),
    });
  } catch (error) {
    console.error(
      "Failed to record a multipart upload nothing points at",
      objectKey,
      error,
    );
  }
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
