import "server-only";
import {
  STORAGE_FILE_COUNT_LIMIT,
  STORAGE_QUOTA_BYTES,
  STORAGE_UPLOAD_PART_BYTES,
} from "@beutl/core";
import {
  claimStorageUploadForAbandon,
  claimStorageUploadCompletion,
  recordStorageUploadCompletionUnknown,
  recordStorageUploadCompletionLateFailure,
  renewStorageUploadCompletion,
  claimStorageUploadCreation,
  attachStorageUploadRemote,
  countFilesByUserId,
  countStorageUploadTombstonesByUserId,
  createFile,
  countStorageUploadsByUserId,
  createStorageUploadCancellationTombstone,
  createStorageUploadIntent,
  deleteClaimedStorageUpload,
  findStorageFileByIdAndUserId,
  findStorageMultipartCleanup,
  findStorageUploadByIdAndUserId,
  enqueueStorageMultipartCleanup,
  markStorageUploadCompleted,
  recordStorageUploadRemoteAfterAttachFailure,
  type PrismaTransaction,
  retrieveFileNamesAndSizesByUserId,
  startRetryableTransaction,
  settleTerminalClaimedStorageUpload,
  STORAGE_MULTIPART_SETTLEMENT_GRACE_MILLISECONDS,
  sumFileSizeByUserId,
  sumStorageUploadSizeByUserId,
} from "@beutl/db";
import { getR2Bucket } from "@beutl/api/ai/r2-provider";

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
const STORAGE_UPLOAD_CLEANUP_LEASE_MILLISECONDS = 5 * 60 * 1000;
// Keep the lease longer than the provider deadline while allowing one
// heartbeat in the bounded wait window.
const STORAGE_UPLOAD_COMPLETION_LEASE_MILLISECONDS = 60 * 1000;
const STORAGE_UPLOAD_COMPLETION_DEADLINE_MILLISECONDS = 30 * 1000;

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

type StartUploadOutcome =
  | { ok: true; upload: StartedUpload }
  | { ok: false; reason: UploadFailure; conflict?: true };

type StorageUploadIntent = {
  userId: string;
  id: string;
  name: string;
  mimeType: string;
  size: bigint;
};

const INTENT_DIGEST_PREFIX = "intent-";
const MAX_COMPLETION_ETAG_LENGTH = 256;

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

async function storageUploadIntentDigest(intent: StorageUploadIntent): Promise<string> {
  const serialized = JSON.stringify({
    version: 1,
    userId: intent.userId,
    id: intent.id,
    name: intent.name,
    mimeType: intent.mimeType,
    size: intent.size.toString(),
    partSize: STORAGE_UPLOAD_PART_BYTES,
    reservationKind: "multipart",
    visibility: "PRIVATE",
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(serialized),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function storageUploadIntentMatches(
  upload: NonNullable<Awaited<ReturnType<typeof findStorageUploadByIdAndUserId>>>,
  intent: StorageUploadIntent,
  intentDigest: string,
): boolean {
  if (
    upload.userId !== intent.userId ||
    upload.id !== intent.id ||
    upload.reservationKind !== "multipart" ||
    upload.mimeType !== intent.mimeType ||
    BigInt(upload.size) !== intent.size ||
    upload.partSize !== STORAGE_UPLOAD_PART_BYTES
  ) {
    return false;
  }

  const prefix = `storage-upload/${intent.userId}/${intent.id}/`;
  const generation = upload.objectKey.startsWith(prefix)
    ? upload.objectKey.slice(prefix.length).split("/", 1)[0]
    : "";
  if (generation.startsWith(INTENT_DIGEST_PREFIX)) {
    return generation === `${INTENT_DIGEST_PREFIX}${intentDigest}`;
  }

  // Rows written before intent digests existed can only be replayed when every
  // directly persisted field agrees. This may conservatively reject a legacy
  // row whose available name received a suffix, but never aliases a new intent.
  return upload.name === intent.name;
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "P2002";
}

function validCompletionParts(
  size: bigint,
  parts: readonly { partNumber: number; etag: string }[],
): boolean {
  const expected = partCountOf(size);
  if (parts.length !== expected) return false;
  return parts.every((part, index) =>
    part.partNumber === index + 1 &&
    typeof part.etag === "string" &&
    part.etag.length > 0 &&
    part.etag.length <= MAX_COMPLETION_ETAG_LENGTH
  );
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
}): Promise<StartUploadOutcome> {
  const intent = { userId, id, name, mimeType, size };
  const intentDigest = await storageUploadIntentDigest(intent);
  const existing = await findStorageUploadByIdAndUserId({ id, userId });
  if (existing) {
    // 完了しているか、掃除に取られているか。どちらもこの名前ではもう続けられ
    // ない——取られた行のパートはもう捨てられている。
    if (existing.completedFileId || existing.abandonedAt) {
      return { ok: false, reason: "uploadFailed" };
    }
    if (!storageUploadIntentMatches(existing, intent, intentDigest)) {
      return { ok: false, reason: "uploadFailed", conflict: true };
    }
    if (existing.uploadId) {
      return {
        ok: true,
        upload: {
          id: existing.id,
          partSize: existing.partSize,
          partCount: partCountOf(existing.size),
        },
      };
    }
  }

  // Persist the quota reservation and deterministic remote identity before
  // touching R2. This is the durable saga's start intent.
  // A client id is a retry identity, not an object generation. A fresh random
  // suffix keeps an expired cleaner for an old same-id row physically unable
  // to delete the object created by its replacement.
  const proposedObjectKey =
    `storage-upload/${userId}/${id}/${INTENT_DIGEST_PREFIX}${intentDigest}/${crypto.randomUUID()}`;
  let upload:
    | Awaited<ReturnType<typeof createStorageUploadIntent>>
    | null
    | "tooMany"
    | "tooManyFiles"
    | "cancelled"
    | "conflict";
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
      // 取り消しの墓標。この名前は始まる前に取り消されているので、始めない。
      if (raced?.abandonedAt) return "cancelled";
      if (raced && !storageUploadIntentMatches(raced, intent, intentDigest)) {
        return "conflict";
      }
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

      return await createStorageUploadIntent({
        userId,
        id,
        objectKey: proposedObjectKey,
        name: await availableName({ userId, name, prisma }),
        mimeType,
        size,
        partSize: STORAGE_UPLOAD_PART_BYTES,
        prisma,
      });
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const raced = await findStorageUploadByIdAndUserId({ id, userId });
      if (raced) {
        upload = storageUploadIntentMatches(raced, intent, intentDigest)
          ? raced
          : "conflict";
      } else {
        // The id is globally unique. A row owned by another account is hidden
        // by the ownership-scoped lookup but still makes this retry identity
        // unusable; reject it without revealing or mutating that row.
        upload = "conflict";
      }
    } else {
      // No remote call happened: the durable intent is the retry handle.
      throw error;
    }
  }

  if (upload === "conflict") {
    return { ok: false, reason: "uploadFailed", conflict: true };
  }

  if (upload === "tooMany") {
    return { ok: false, reason: "tooManyUploads" };
  }

  if (upload === "tooManyFiles") {
    return { ok: false, reason: "tooManyFiles" };
  }

  if (upload === "cancelled") {
    return { ok: false, reason: "uploadFailed" };
  }

  if (!upload) {
    return { ok: false, reason: "insufficientStorageSpace" };
  }

  if (upload.uploadId) {
    return { ok: true, upload: { id: upload.id, partSize: upload.partSize, partCount: partCountOf(upload.size) } };
  }

  const leaseToken = crypto.randomUUID();
  const creationClaimedAt = new Date();
  const creationLeaseUntil = new Date(
    creationClaimedAt.getTime() + 5 * 60 * 1000,
  );
  const claimed = await claimStorageUploadCreation({
    id,
    userId,
    now: creationClaimedAt,
    leaseUntil: creationLeaseUntil,
    leaseToken,
  });
  if (!claimed) {
    const current = await findStorageUploadByIdAndUserId({ id, userId });
    if (current && !storageUploadIntentMatches(current, intent, intentDigest)) {
      return { ok: false, reason: "uploadFailed", conflict: true };
    }
    if (current?.uploadId) {
      return { ok: true, upload: { id: current.id, partSize: current.partSize, partCount: partCountOf(current.size) } };
    }
    return { ok: false, reason: "uploadFailed" };
  }

  let multipart: { uploadId: string };
  try {
    multipart = await bucket().createMultipartUpload(upload.objectKey, {
      httpMetadata: upload.mimeType
        ? { contentType: upload.mimeType }
        : undefined,
    });
  } catch (error) {
    // R2's binding does not expose a way to list multipart uploads. If the
    // provider created one but lost the response before returning uploadId,
    // no application code can name or abort that handle. Keep the durable
    // intent and its lease so the same request id can retry after expiry; the
    // bucket's incomplete-multipart lifecycle is the last resort for the
    // provider-side handle whose id was never observed.
    console.error(
      "Multipart creation failed before an uploadId was observed; the durable intent remains retryable",
      { id, objectKey: upload.objectKey },
      error,
    );
    throw error;
  }
  let attached = false;
  const attachErrors: unknown[] = [];
  for (let attempt = 0; attempt < 3 && !attached; attempt++) {
    try {
      attached = await attachStorageUploadRemote({ id, userId, uploadId: multipart.uploadId, leaseToken });
    } catch (error) {
      attachErrors.push(error);
      if (attempt === 2) console.error("Failed to attach multipart handle; leaving durable creating intent", id, error);
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
  if (!attached) {
    const primary = attachErrors.length === 0
      ? new Error("Storage upload remote handle could not be durably attached")
      : new AggregateError(
          attachErrors,
          "Storage upload remote handle could not be durably attached",
        );
    await recoverKnownMultipart({
      userId,
      id,
      objectKey: upload.objectKey,
      uploadId: multipart.uploadId,
      intent: upload,
      creationLeaseUntil,
      creationLeaseToken: leaseToken,
      primary,
    });
    attached = true;
  }

  return {
    ok: true,
    upload: {
      id: upload.id,
      partSize: upload.partSize,
      partCount: partCountOf(upload.size),
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
  if (!upload.uploadId) return { ok: false, reason: "uploadFailed" };

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
  if (upload.completionState === "intervention") return { ok: false, reason: "uploadFailed" };
  if (!upload.uploadId) return { ok: false, reason: "uploadFailed" };

  // Retry/completing rows may still have a provider-side commit in flight (or
  // may have committed before its response was lost). Never issue a second
  // complete call; recover only from a visible object or receipt.
  if (!["idle", "resumed"].includes(upload.completionState)) {
    const existing = await joinedObjectState(upload.objectKey);
    if (existing.kind === "present") return await finalizeUpload(upload, userId, BigInt(existing.size));
    return { ok: false, reason: "uploadFailed" };
  }
  if (upload.completionState === "resumed" || upload.completionAttempts > 0) {
    const existing = await joinedObjectState(upload.objectKey);
    if (existing.kind === "present") return await finalizeUpload(upload, userId, BigInt(existing.size));
    if (existing.kind === "unknown") return { ok: false, reason: "uploadFailed" };
    // An operator explicitly resumed this generation; an absent object is the
    // only case in which a fresh provider completion is authorized.
  }

  // R2 joins exactly the submitted list. Require the complete, ordered 1..N
  // set derived from the persisted reservation so a truncated, duplicated or
  // reordered client list can never publish a different object generation.
  if (!validCompletionParts(upload.size, parts)) {
    return { ok: false, reason: "uploadFailed" };
  }

  // resumeMultipartUpload only constructs a local handle; it does not invoke
  // the provider. Construct it before publishing the durable completion fence
  // so a synchronous SDK/configuration failure cannot strand a `completing`
  // row that the scheduler would later (and incorrectly) classify as an
  // unknown remote outcome.
  let multipart: ReturnType<
    NonNullable<ReturnType<typeof bucket>["resumeMultipartUpload"]>
  >;
  try {
    multipart = bucket().resumeMultipartUpload(upload.objectKey, upload.uploadId);
  } catch {
    return { ok: false, reason: "uploadFailed" };
  }

  // Publish the completion fence before touching R2. A competing completion
  // or stale cleanup may observe a provider-side transient failure, but cannot
  // claim this generation while this lease is unexpired.
  let completing = upload;
  let claimed = false;
  let completionLeaseToken = "";
  const now = new Date();
  const leaseToken = crypto.randomUUID();
  claimed = await claimStorageUploadCompletion({
    id: completing.id,
    userId,
    now,
    leaseUntil: new Date(now.getTime() + STORAGE_UPLOAD_COMPLETION_LEASE_MILLISECONDS),
    leaseToken,
    expected: storageUploadGenerationOf(completing),
  });
  if (claimed) {
    const current = await findStorageUploadByIdAndUserId({ id: completing.id, userId });
    if (
      !current ||
      current.completionState !== "completing" ||
      current.completionLeaseToken !== leaseToken
    ) {
      return { ok: false, reason: "uploadFailed" };
    }
    completing = current;
    completionLeaseToken = leaseToken;
  }
  if (!claimed) {
    const current = await findStorageUploadByIdAndUserId({ id: completing.id, userId });
    if (!current) return { ok: false, reason: "uploadNotFound" };
    if (!sameStorageUploadGeneration(current, completing)) {
      return { ok: false, reason: "uploadNotFound" };
    }
    if (current.completedFileId) {
      const file = await findStorageFileByIdAndUserId({ id: current.completedFileId, userId });
      return file
        ? { ok: true, file: { id: file.id, name: file.name, size: BigInt(file.size) } }
        : { ok: false, reason: "fileNotFound" };
    }
    const existing = await joinedObjectState(current.objectKey);
    if (existing.kind === "present") return await finalizeUpload(current, userId, BigInt(existing.size));
    return { ok: false, reason: "uploadFailed" };
  }

  let object: { size: number };
  const providerCompletion = Promise.resolve().then(() => multipart.complete(parts)).then(
    (value) => ({ kind: "completed" as const, value }),
    (error: unknown) => ({ kind: "failed" as const, error }),
  );
  let providerOutcome: Awaited<typeof providerCompletion>;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ kind: "deadline" }>((resolve) => { deadlineTimer = setTimeout(() => resolve({ kind: "deadline" }), STORAGE_UPLOAD_COMPLETION_DEADLINE_MILLISECONDS); });
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const renewalTick = new Promise<{ kind: "renew" }>((resolve) => {
      timer = setTimeout(
        () => resolve({ kind: "renew" }),
        Math.max(1_000, Math.floor(STORAGE_UPLOAD_COMPLETION_LEASE_MILLISECONDS / 3)),
      );
    });
    const outcome = await Promise.race([providerCompletion, renewalTick, deadline]);
    if (outcome.kind === "deadline") {
      if (timer) clearTimeout(timer);
      deadlineTimer = undefined;
      await persistUnknownBounded(completing, userId, completionLeaseToken, "Remote multipart completion exceeded deadline");
      // Keep a continuation when the runtime survives the request deadline.
      // It can only settle the same generation after reloading its durable
      // unknown state; it never issues another provider complete call.
      void providerCompletion.then(async (late) => {
        const current = await findStorageUploadByIdAndUserId({ id: completing.id, userId }).catch(() => null);
        if (!current || current.completionState !== "unknown") return;
        if (late.kind !== "completed") {
          if (!current.completionInterventionAt) return;
          await recordStorageUploadCompletionLateFailure({ id: completing.id, userId, expected: storageUploadGenerationOf(current), expectedInterventionAt: current.completionInterventionAt, error: late.error instanceof Error ? late.error.message : String(late.error) }).catch(() => undefined);
          return;
        }
        await finalizeUpload(current, userId, BigInt(late.value.size)).catch((error) => console.error("Failed to finalize a late storage completion", completing.id, error));
      }, () => undefined);
      return { ok: false, reason: "uploadFailed" };
    }
    if (outcome.kind !== "renew") {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (timer) clearTimeout(timer);
      providerOutcome = outcome;
      break;
    }

    const now = new Date();
    const leaseUntil = new Date(
      now.getTime() + STORAGE_UPLOAD_COMPLETION_LEASE_MILLISECONDS,
    );
    try {
      // Renewal is best-effort bookkeeping. A wedged database must not extend
      // the request past the provider deadline: race it against the same
      // deadline used for multipart.complete().
      const renewal = renewStorageUploadCompletion({
        id: completing.id,
        userId,
        now,
        leaseUntil,
        leaseToken: completionLeaseToken,
        expected: storageUploadGenerationOf(completing),
      }).then((renewed) => ({ kind: "renewed" as const, renewed }), (error) => ({ kind: "renewalFailed" as const, error }));
      const renewalOutcome = await Promise.race([renewal, deadline]);
      if (renewalOutcome.kind === "deadline") {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
        await persistUnknownBounded(completing, userId, completionLeaseToken, "Remote multipart completion exceeded deadline");
        void providerCompletion.then(async (late) => {
          const current = await findStorageUploadByIdAndUserId({ id: completing.id, userId }).catch(() => null);
          if (!current || current.completionState !== "unknown") return;
          if (late.kind !== "completed") return;
          await finalizeUpload(current, userId, BigInt(late.value.size)).catch((error) => console.error("Failed to finalize a late storage completion", completing.id, error));
        }, () => undefined);
        return { ok: false, reason: "uploadFailed" };
      }
      if (renewalOutcome.kind === "renewalFailed") throw renewalOutcome.error;
      const renewed = renewalOutcome.renewed;
      if (!renewed) {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        void providerCompletion.then(() => undefined, () => undefined);
        return { ok: false, reason: "uploadFailed" };
      }
      completing = { ...completing, completionLeaseUntil: leaseUntil };
    } catch (error) {
      console.error("Failed to renew a storage completion lease", completing.id, error);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      void providerCompletion.then(() => undefined, () => undefined);
      return { ok: false, reason: "uploadFailed" };
    }
  }

  // The remote call may already have committed, but without the durable fence
  // this caller no longer owns either finalization or cleanup. Leave every
  // remote and local artifact in place for the current database owner.
  try {
    if (providerOutcome.kind === "failed") throw providerOutcome.error;
    object = providerOutcome.value;
  } catch (error) {
    // Another completion of the same upload may have joined the parts already,
    // in which case the bucket no longer knows this upload id. Its file is the
    // answer, and neither the object nor the row is this call's to remove.
    const settled = await completedFileOf(completing.id, userId, completing);
    if (settled.kind === "completed") return { ok: true, file: settled.file };
    if (settled.kind === "unknown") {
      await recordStorageUploadCompletionUnknown({ id: completing.id, userId, leaseToken: completionLeaseToken, expected: storageUploadGenerationOf(completing), error: "Completion receipt lookup failed", now: new Date() }).catch(() => undefined);
      return { ok: false, reason: "uploadFailed" };
    }

    // 控えは無いのに、アップロード id は知られていない。組み上げは終わったのに
    // その直後に落ちた、という形がこれになる。R2 は結合済みのアップロードを
    // 忘れるので、中止も組み直しもできない——オブジェクトが在るかどうかだけが
    // 見分けになる。在るならこの呼び出しが仕上げる。無いという一回の観測では、
    // 応答を失った完了が後から現れないと証明できないので unknown のまま保持する。
    const joined = await joinedObjectState(completing.objectKey);
    if (joined.kind === "present") {
      return await finalizeUpload(completing, userId, BigInt(joined.size));
    }
    if (joined.kind === "unknown") {
      // complete() may have committed even though its response was lost. A
      // transient HEAD failure is not proof that the object is absent, so do
      // not claim cleanup, abort the handle, or schedule object deletion.
      await recordStorageUploadCompletionUnknown({ id: completing.id, userId, leaseToken: completionLeaseToken, expected: storageUploadGenerationOf(completing), error: "Joined object lookup failed", now: new Date() }).catch(() => undefined);
      return { ok: false, reason: "uploadFailed" };
    }

    await recordStorageUploadCompletionUnknown({
      id: completing.id,
      userId,
      leaseToken: completionLeaseToken,
      expected: storageUploadGenerationOf(completing),
      error: error instanceof Error ? error.message : String(error),
      now: new Date(),
    }).catch(() => undefined);
    const concurrent = await completedFileOf(completing.id, userId, completing);
    if (concurrent.kind === "completed") return { ok: true, file: concurrent.file };
    return { ok: false, reason: "uploadFailed" };
  }

  return await finalizeUpload(completing, userId, BigInt(object.size));
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
    | { kind: "replaced" }
    | { kind: "gone" };
  try {
    outcome = await startRetryableTransaction(async (prisma) => {
      const current = await findStorageUploadByIdAndUserId({
        id: upload.id,
        userId,
        prisma,
      });
      if (!current) return { kind: "gone" as const };
      if (!sameStorageUploadGeneration(current, upload)) {
        return { kind: "replaced" as const };
      }
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
        objectKey: current.objectKey,
        name: current.name,
        size: Number(actual),
        mimeType: current.mimeType,
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
          userId,
          fileId: created.id,
          expected: storageUploadGenerationOf(upload),
          prisma,
        })
      ) {
        throw new UploadWasAbandoned();
      }
      return { kind: "created" as const, id: created.id, name: created.name };
    });
  } catch (error) {
    if (error instanceof UploadWasAbandoned) {
      // The cleanup claimant owns the object now. This finalizer has no cleanup
      // lease and must not race its remote effect.
      return { ok: false, reason: "uploadFailed" };
    }

    // A failure reported after the commit landed is indistinguishable from one
    // reported before it, so the row is what decides. Reading it is not enough:
    // another completion of the same upload may be in a transaction that has
    // not committed yet, and deleting the object on the strength of "no receipt
    // yet" would leave the file it is about to record pointing at nothing.
    // Claiming the row settles it — a claimed row can never take a receipt, so
    // whatever is in the bucket is this call's to remove.
    const cleanupUpload = await claimForCleanup(
      upload,
      userId,
      upload.completionLeaseToken ?? undefined,
    );
    if (!cleanupUpload) {
      const settled = await completedFileOf(upload.id, userId, upload);
      if (settled.kind === "completed") return { ok: true, file: settled.file };
      if (settled.kind === "replaced") {
        return { ok: false, reason: "uploadNotFound" };
      }
      // 取れず、控えも読めない。File が指しているかもしれないオブジェクトを
      // 消すのは取り返しがつかないので、掃除に任せる。
      throw error;
    }

    // Nothing points at the object, and nothing ever can: it would be stored,
    // and paid for, without ever being seen again.
    if (!await stillOwnClaimedUpload(cleanupUpload, userId)) throw error;
    try {
      const remove = bucket().delete;
      if (!remove) throw new Error("The configured bucket cannot delete objects");
      await remove(cleanupUpload.objectKey);
    } catch (cleanupError) {
      // 消せなかった。行は残す——sweeper がもう一度試せる唯一の手掛かりなので。
      throw new AggregateError(
        [error, cleanupError],
        "The upload failed and its object could not be cleaned up",
      );
    }

    // 消せたなら片付けるものはもう無い。行を残しても、宣言された大きさで枠を
    // 押さえ続けるだけになる。行を消せなかったときは、掃除が同じところに来て
    // 片付ける——取ってある行なので、控えが書かれることはもう無い。
    await deleteClaimedUpload(cleanupUpload, userId).catch((cleanupError: unknown) => {
      console.error(
        "Failed to drop the row of an upload whose object was cleared",
        cleanupUpload.id,
        cleanupError,
      );
    });
    throw error;
  }

  if (outcome.kind === "gone") return { ok: false, reason: "uploadNotFound" };
  if (outcome.kind === "replaced") {
    return { ok: false, reason: "uploadNotFound" };
  }
  if (outcome.kind === "abandoned") {
    // Another cleanup owner froze this generation. Only its cleanup lease may
    // perform the remote effect.
    return { ok: false, reason: "uploadFailed" };
  }

  if (outcome.kind === "overQuota" || outcome.kind === "tooManyFiles") {
    // 断ったのはこの呼び出しだが、同じアップロードを仕上げようとしている別の
    // 呼び出しがいるかもしれない。行を取れたときだけ消す。
    const cleanupUpload = await claimForCleanup(
      upload,
      userId,
      upload.completionLeaseToken ?? undefined,
    );
    if (cleanupUpload) {
      if (await stillOwnClaimedUpload(cleanupUpload, userId)) {
        const remove = bucket().delete;
        if (remove) {
          await remove(cleanupUpload.objectKey);
          await deleteClaimedUpload(cleanupUpload, userId);
        }
      }
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
    const settled = await completedFileOf(upload.id, userId, upload);
    return settled.kind === "completed"
      ? { ok: true, file: settled.file }
      : { ok: false, reason: "fileNotFound" };
  }

  return { ok: true, file: { id: outcome.id, name: outcome.name, size: actual } };
}

// 取引を巻き戻すためだけの合図。掃除に行を取られたので、File を作らずに戻る。
class UploadWasAbandoned extends Error {}

type JoinedObjectState =
  | { kind: "present"; size: number }
  | { kind: "absent" }
  | { kind: "unknown" };

async function persistUnknownBounded(
  upload: TrackedUpload,
  userId: string,
  leaseToken: string,
  error: string,
): Promise<void> {
  const persistence = recordStorageUploadCompletionUnknown({
    id: upload.id,
    userId,
    leaseToken,
    expected: storageUploadGenerationOf(upload),
    error,
    now: new Date(),
  }).catch(() => undefined);
  await Promise.race([
    persistence,
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  // Keep observing a late DB completion; its CAS generation fence prevents it
  // from overwriting a newer settled/claimed state.
  void persistence;
}

// R2 object visibility is strongly consistent after a successful multipart
// complete, but a failed HEAD transport is not an "absent" observation.
async function joinedObjectState(objectKey: string): Promise<JoinedObjectState> {
  try {
    const head = bucket().head;
    if (!head) return { kind: "unknown" };
    const object = await head(objectKey);
    if (object === null) return { kind: "absent" };
    // A present object without a trustworthy size cannot be recorded as a
    // File, but it must not be cleaned up as though it were absent.
    return typeof object.size === "number" && Number.isSafeInteger(object.size)
      && object.size >= 0
      ? { kind: "present", size: object.size }
      : { kind: "unknown" };
  } catch (error) {
    console.error("Failed to look for a joined upload object", objectKey, error);
    return { kind: "unknown" };
  }
}

export async function cancelUpload({
  userId,
  uploadId,
}: {
  userId: string;
  uploadId: string;
}): Promise<CancelOutcome> {
  let upload = await findStorageUploadByIdAndUserId({ id: uploadId, userId });
  // まだ無い。始めた側の応答が返らずに取り消しへ回ったときは、開始のほうが
  // まだ書き込み中ということがある。ここで「もう無い」と答えて終わると、その
  // あとに現れた行が一日ぶんの枠を抱えたまま残るので、代わりに墓標を置く——
  // その名前で始めようとしたものは、この行にぶつかって始まらない。
  if (!upload) return await recordCancellation(userId, uploadId);

  // A finished upload has no parts left to throw away, and its receipt is the
  // durable answer to a completion whose response may have been lost. Keep it
  // so a completion retry still returns the same File after cancellation.
  if (upload.completedFileId) {
    return "cancelled";
  }

  // 取れないのは、完了したか、掃除のものになったか。掃除のものというのは、前の
  // 取り消しがここまで来て中止に失敗したということでもある——その場合はもう
  // 一度中止を試す。控えはもう書けないので、消して困るものは残っていない。
  const cleanupUpload = await claimForCleanup(upload, userId);
  if (!cleanupUpload) {
    let current;
    try {
      current = await findStorageUploadByIdAndUserId({ id: uploadId, userId });
    } catch {
      // 読めなかった。取れなかったのが「もう無いから」なのか「一時の不調」なのか
      // 分からない以上、片付いたとは言えない——言えば呼び出し側はそこで手を引き、
      // パートは誰も取りに行かないまま残る。もう一度来てもらう。
      return "pending";
    }
    // Cleanup is complete only when the row is gone or completed. A live row
    // means the claim failed transiently, so keep it retryable.
    if (current === null || current.completedFileId) {
      return "cancelled";
    }
    return "pending";
  } else {
    upload = cleanupUpload;
  }

  if (!upload.uploadId) {
    await deleteClaimedUpload(upload, userId);
    return "cancelled";
  }

  // The row is only dropped once the parts are known to be gone. Dropping it
  // after a failed abort leaves parts nothing knows about, which the sweep can
  // then never find.
  if (!upload.uploadId || !await stillOwnClaimedUpload(upload, userId)) {
    // まだバケットに残っている。片付いたと答えると、呼び出し側はそこで手を
    // 引き、その分の枠が一日残る——まだ終わっていないと言って、もう一度来て
    // もらう。次の掃除も同じ行を拾う。
    return "pending";
  }
  const abort = await abortTrackedMultipart(upload.objectKey, upload.uploadId);
  if (abort.kind === "failed") return "pending";
  const settled = abort.kind === "terminal"
    ? await settleTerminalClaimedUpload(upload, userId)
    : await deleteClaimedUpload(upload, userId);
  return settled ? "cancelled" : "pending";
}

// 取り消しがどこまで行ったか。片付いた／まだ残っている／そんなものは無い。
export type CancelOutcome = "cancelled" | "pending" | "missing";

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
  | { kind: "replaced" }
  // 読めなかった。「レシートが無い」とは違う——ここで取り違えると、実際には
  // File が指しているオブジェクトを消してしまう。
  | { kind: "unknown" };

async function completedFileOf(
  uploadId: string,
  userId: string,
  expected: TrackedUpload,
): Promise<CompletionReceipt> {
  let current;
  try {
    current = await findStorageUploadByIdAndUserId({ id: uploadId, userId });
  } catch (error) {
    console.error("Failed to read a storage upload receipt", uploadId, error);
    return { kind: "unknown" };
  }

  if (!current) return { kind: "none" };
  if (!sameStorageUploadGeneration(current, expected)) {
    return { kind: "replaced" };
  }
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

function sameStorageUploadGeneration(
  current: TrackedUpload,
  expected: TrackedUpload,
): boolean {
  return current.id === expected.id &&
    current.userId === expected.userId &&
    current.createdAt.getTime() === expected.createdAt.getTime() &&
    current.reservationKind === expected.reservationKind &&
    current.objectKey === expected.objectKey &&
    current.uploadId === expected.uploadId &&
    current.name === expected.name &&
    current.mimeType === expected.mimeType &&
    current.size === expected.size &&
    current.partSize === expected.partSize &&
    current.startState === expected.startState &&
    current.creationLeaseUntil?.getTime() ===
      expected.creationLeaseUntil?.getTime() &&
    current.creationLeaseToken === expected.creationLeaseToken &&
    current.completionRevision === expected.completionRevision &&
    current.completionRetryNotBefore?.getTime() ===
      expected.completionRetryNotBefore?.getTime() &&
    current.unknownProbeNotBefore?.getTime() === expected.unknownProbeNotBefore?.getTime() &&
    current.unknownProbeLeaseToken === expected.unknownProbeLeaseToken;
}

function storageUploadGenerationOf(upload: TrackedUpload) {
  return {
    reservationKind: upload.reservationKind,
    createdAt: upload.createdAt,
    objectKey: upload.objectKey,
    uploadId: upload.uploadId,
    name: upload.name,
    mimeType: upload.mimeType,
    size: upload.size,
    partSize: upload.partSize,
    startState: upload.startState,
    creationLeaseUntil: upload.creationLeaseUntil,
    creationLeaseToken: upload.creationLeaseToken,
    completionState: upload.completionState,
    completionLeaseUntil: upload.completionLeaseUntil,
    completionLeaseToken: upload.completionLeaseToken,
    completionRevision: upload.completionRevision,
    completionRetryNotBefore: upload.completionRetryNotBefore,
    unknownProbeNotBefore: upload.unknownProbeNotBefore,
    unknownProbeLeaseToken: upload.unknownProbeLeaseToken,
  };
}

// まだ現れていない名前の取り消しを、先回りして書き留める。始めるほうはこの行に
// ぶつかって始められず、作りかけのマルチパートを自分で捨てる。置けたということ
// は取り消せたということ——置けなかったのは、その一瞬に行のほうが現れたときで、
// そちらは普通の取り消しとして片付ける。
//
// 墓標そのものは何も抱えていないので、掃除が次に回ってきたときに消える。
async function recordCancellation(
  userId: string,
  uploadId: string,
): Promise<CancelOutcome> {
  try {
    // 墓標は誰でも、どんな名前にでも置ける——そんな名前は無い、という取り消しに
    // 応えて書くものなので。抱えているものが無いぶん枠にも本数にも数えられず、
    // 数だけが増えるので、ここで限る。1 つのブラウザが同時に始められる本数を
    // 超えて必要になることはない。
    //
    // 数えるのと書くのは一続きにする。別々にすると、同時に届いた取り消しが
    // どれも「まだ上限より下」を読み、いくらでも置けてしまう。
    const placed = await startRetryableTransaction(async (prisma) => {
      const already = await countStorageUploadTombstonesByUserId({ userId, prisma });
      if (already >= MAX_ACTIVE_UPLOADS) return false;

      await createStorageUploadCancellationTombstone({ userId, id: uploadId, now: new Date(), prisma });
      return true;
    });
    return placed ? "cancelled" : "missing";
  } catch {
    // 一瞬の差で行のほうが現れた。もう一度来てもらえば、そちらを片付ける。
    return "missing";
  }
}

// 「この行のパートとオブジェクトは自分が捨てる」と宣言する。取れた行にはもう
// 控えを書けないので、そのあと何を消しても File が消えたものを指すことはない。
// 完了済み・宣言済みの行は取れない。
async function claimForCleanup(
  expected: TrackedUpload,
  userId: string,
  completionOwnerToken?: string,
): Promise<TrackedUpload | null> {
  const now = new Date();
  const cleanupLeaseToken = crypto.randomUUID();
  try {
    await claimStorageUploadForAbandon({
      id: expected.id,
      userId,
      now,
      cleanupLeaseToken,
      cleanupLeaseUntil: new Date(
        now.getTime() + STORAGE_UPLOAD_CLEANUP_LEASE_MILLISECONDS,
      ),
      completionOwnerToken,
      expected: {
        ...storageUploadGenerationOf(expected),
        abandonedAt: expected.abandonedAt,
        cleanupLeaseUntil: expected.cleanupLeaseUntil,
        cleanupLeaseToken: expected.cleanupLeaseToken,
      },
    });
  } catch (error) {
    console.error("Failed to claim a storage upload for cleanup", expected.id, error);
    return null;
  }

  try {
    const current = await findStorageUploadByIdAndUserId({
      id: expected.id,
      userId,
    });
    return current?.abandonedAt &&
        !current.completedFileId &&
        current.cleanupLeaseToken === cleanupLeaseToken
      ? current
      : null;
  } catch (error) {
    console.error(
      "Failed to reload a claimed storage upload",
      expected.id,
      error,
    );
    return null;
  }
}

async function deleteClaimedUpload(
  upload: TrackedUpload,
  userId: string,
): Promise<boolean> {
  if (!upload.abandonedAt) return false;
  return await deleteClaimedStorageUpload({
    id: upload.id,
    userId,
    expected: {
      ...storageUploadGenerationOf(upload),
      abandonedAt: upload.abandonedAt,
      cleanupLeaseUntil: upload.cleanupLeaseUntil,
      cleanupLeaseToken: upload.cleanupLeaseToken,
    },
  });
}

async function settleTerminalClaimedUpload(
  upload: TrackedUpload,
  userId: string,
): Promise<boolean> {
  if (!upload.abandonedAt) return false;
  const now = new Date();
  return await settleTerminalClaimedStorageUpload({
    id: upload.id,
    userId,
    expected: claimedUploadExpectation(upload),
    now,
    objectCleanupNotBefore: new Date(
      now.getTime() + STORAGE_MULTIPART_SETTLEMENT_GRACE_MILLISECONDS,
    ),
  });
}

function claimedUploadExpectation(upload: TrackedUpload) {
  if (!upload.abandonedAt) {
    throw new Error(`Storage upload ${upload.id} is not claimed for cleanup`);
  }
  return {
    ...storageUploadGenerationOf(upload),
    abandonedAt: upload.abandonedAt,
    cleanupLeaseUntil: upload.cleanupLeaseUntil,
    cleanupLeaseToken: upload.cleanupLeaseToken,
  };
}

async function stillOwnClaimedUpload(
  expected: TrackedUpload,
  userId: string,
): Promise<boolean> {
  try {
    const current = await findStorageUploadByIdAndUserId({
      id: expected.id,
      userId,
    });
    return Boolean(
      current &&
      current.createdAt.getTime() === expected.createdAt.getTime() &&
      current.uploadId === expected.uploadId &&
      current.abandonedAt?.getTime() === expected.abandonedAt?.getTime() &&
      current.cleanupLeaseToken === expected.cleanupLeaseToken,
    );
  } catch {
    return false;
  }
}

// A database write can commit and still report a transport failure. Reload the
// authoritative row after both attach and fallback record attempts before
// deciding that this handle is unpublished. Aborting first could destroy the
// only handle an active upload now owns.
async function recoverKnownMultipart({
  userId,
  id,
  objectKey,
  uploadId,
  intent,
  creationLeaseUntil,
  creationLeaseToken,
  primary,
}: {
  userId: string;
  id: string;
  objectKey: string;
  uploadId: string;
  intent: TrackedUpload;
  creationLeaseUntil: Date;
  creationLeaseToken: string;
  primary: Error;
}): Promise<void> {
  const evidence: unknown[] = [];

  type CurrentUploadRead =
    | { kind: "found"; upload: TrackedUpload }
    | { kind: "absent" }
    | { kind: "unknown" };

  const readCurrent = async (): Promise<CurrentUploadRead> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const current = await findStorageUploadByIdAndUserId({ id, userId });
        return current
          ? { kind: "found", upload: current }
          : { kind: "absent" };
      } catch (error) {
        evidence.push(error);
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
        }
      }
    }
    return { kind: "unknown" };
  };

  const classifyCurrent = async (
    current: TrackedUpload,
  ): Promise<boolean> => {
    if (current.uploadId !== uploadId) return false;
    if (!current.abandonedAt && !current.completedFileId) return true;
    if (current.completedFileId) {
      throw new AggregateError(
        [primary, ...evidence],
        "Storage upload start resolved to an already-completed receipt",
      );
    }
    await persistDetachedMultipartCleanup({
      objectKey,
      uploadId,
      primary,
      evidence,
    });
    return false;
  };

  const afterAttach = await readCurrent();
  if (
    afterAttach.kind === "found" &&
    await classifyCurrent(afterAttach.upload)
  ) return;

  try {
    if (!await recordStorageUploadRemoteAfterAttachFailure({
      id,
      userId,
      uploadId,
      expected: {
        ...storageUploadGenerationOf(intent),
        uploadId: null,
        startState: "creating",
        creationLeaseUntil,
        creationLeaseToken,
      },
    })) {
      evidence.push(
        new Error("The existing upload row did not accept the remote handle"),
      );
    }
  } catch (error) {
    evidence.push(error);
  }

  const afterRecord = await readCurrent();
  if (afterRecord.kind === "found") {
    if (await classifyCurrent(afterRecord.upload)) return;
    await persistDetachedMultipartCleanup({
      objectKey,
      uploadId,
      primary,
      evidence,
    });
  }
  if (afterRecord.kind === "absent") {
    await persistDetachedMultipartCleanup({
      objectKey,
      uploadId,
      primary,
      evidence,
    });
  }

  // A write can commit and report a transport error. If every authoritative
  // reload also failed, enqueueing an abort would risk killing that committed
  // active handle. Fail closed and retain the durable start intent; R2's
  // incomplete-multipart lifecycle remains the fallback if the handle was in
  // fact unpublished.
  throw new AggregateError(
    [primary, ...evidence],
    "Storage upload start outcome could not be verified",
  );
}

async function persistDetachedMultipartCleanup({
  objectKey,
  uploadId,
  primary,
  evidence,
}: {
  objectKey: string;
  uploadId: string;
  primary: Error;
  evidence: unknown[];
}): Promise<never> {
  let enqueueReturned = false;
  try {
    await enqueueStorageMultipartCleanup({
      objectKey,
      uploadId,
    });
    enqueueReturned = true;
  } catch (error) {
    evidence.push(error);
  }

  let durable = enqueueReturned;
  try {
    durable = durable || Boolean(await findStorageMultipartCleanup({
      objectKey,
      uploadId,
    }));
  } catch (error) {
    evidence.push(error);
  }
  if (!durable) {
    throw new AggregateError(
      [primary, ...evidence],
      "Storage upload start failed and its multipart handle could not be made durable",
    );
  }

  throw new AggregateError(
    [primary, ...evidence],
    "Storage upload start failed after its multipart handle was recorded for cleanup",
  );
}

function isTerminalMultipartAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as Record<string, unknown>;
  const code = String(record.code ?? record.name ?? "").toLowerCase();
  if (code === "nosuchupload") return true;
  return /(?:\(\s*10024\s*\)|\b10024)\s*$/u.test(
    String(record.message ?? error),
  );
}

async function abortTrackedMultipart(
  objectKey: string,
  uploadId: string,
): Promise<
  | { kind: "aborted" }
  | { kind: "terminal" }
  | { kind: "failed"; error: unknown }
> {
  try {
    await bucket().resumeMultipartUpload(objectKey, uploadId).abort();
    return { kind: "aborted" };
  } catch (error) {
    if (isTerminalMultipartAbortError(error)) {
      return { kind: "terminal" };
    }
    console.error("Failed to abandon a storage upload", error);
    return { kind: "failed", error };
  }
}
