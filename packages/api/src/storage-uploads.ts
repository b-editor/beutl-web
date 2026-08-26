import {
  claimStorageUploadForAbandon,
  deleteStorageUpload,
  findStorageUploadByIdAndUserId,
  listStorageUploadsStartedBefore,
  releaseStorageUploadCreation,
} from "@beutl/db";
import { getR2Bucket } from "./ai/storage";

// Giving up on uploads nobody finished.
//
// A file too large for one request arrives in parts, and the bucket holds those
// parts under an upload id until they are either joined into the file or thrown
// away. A browser that is closed midway does neither, and what it left behind
// is stored — and paid for — until something abandons it.
//
// Nothing here destroys anything it has not first claimed. Reading the row and
// then acting on what it said is not enough: a completion landing in between
// would write a receipt for an object this sweep is about to delete, and the
// file would point at nothing. Claiming the row shuts that door — a claimed row
// can no longer take a receipt — so whatever is left in the bucket is this
// sweep's to throw away.
//
// Long enough that a slow upload of the largest file this service takes is
// never mistaken for an abandoned one.
const ABANDON_AFTER_MILLISECONDS = 24 * 60 * 60 * 1000;
// 取り消しの墓標を置いたまま待つ時間。遅れて現れる開始を止めるために置くもの
// なので、開始の要求が生きていられるより長く。
const TOMBSTONE_GRACE_MILLISECONDS = 15 * 60 * 1000;
const MAX_PER_RUN = 100;

function isTerminalMultipartAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as Record<string, unknown>;
  const code = String(record.code ?? record.name ?? "").toLowerCase();
  if (code === "nosuchupload") return true;
  return /(?:\(\s*10024\s*\)|\b10024)\s*$/u.test(
    String(record.message ?? error),
  );
}

async function deleteObjectAfterTerminalAbort(objectKey: string): Promise<boolean> {
  try {
    const bucket = getR2Bucket();
    if (!bucket.head || !bucket.delete) return false;
    if (!await bucket.head(objectKey)) return true;
    await bucket.delete(objectKey);
    return true;
  } catch (error) {
    console.error("Failed to clear object after terminal multipart abort", objectKey, error);
    return false;
  }
}

export async function abandonStaleStorageUploads(
  now: Date = new Date(),
): Promise<{ abandoned: number; failed: number }> {
  const stale = await listStorageUploadsStartedBefore({
    before: new Date(now.getTime() - ABANDON_AFTER_MILLISECONDS),
    limit: MAX_PER_RUN,
  });

  let abandoned = 0;
  let failed = 0;
  for (const upload of stale) {
    // 一覧を引いてから順番が回ってくるまでの間に、そのアップロードが完了して
    // いることがある。行を取れなければ、それは完了したか、既に誰かが取ったか。
    const claimed = await claimStorageUploadForAbandon({
      id: upload.id,
      userId: upload.userId,
      now,
    }).catch(() => false);
    if (!claimed) {
      // 取れなかった理由を確かめる。完了していたなら控えを片付けるだけ。前の回で
      // 自分が取ったまま中止に失敗した行なら、そのまま捨てにかかってよい——
      // 取られた行にはもう控えが書けないので、消して困るものは残っていない。
      const current = await findStorageUploadByIdAndUserId({
        id: upload.id,
        userId: upload.userId,
      }).catch(() => null);
      if (!current) continue;
      if (current.completedFileId) {
        // Completion receipts are bounded by the user's file-count limit and
        // cascade with their File row; they are never multipart sweep state.
        continue;
      }
      if (!current.abandonedAt) continue;
    }

    // A pre-create intent has no remote handle to abort. Expired creating leases
    // are returned to the retryable intent state; they keep their quota
    // reservation until a later start either attaches the handle or cancellation
    // claims the row. This avoids dropping the only durable request identity.
    if (upload.uploadId === null) {
      if (upload.startState === "creating") {
        await releaseStorageUploadCreation({ id: upload.id, now, leaseToken: (upload as { creationLeaseToken?: string | null }).creationLeaseToken ?? null }).catch(() => undefined);
      } else {
        // An intent has never contacted R2, so dropping it after the normal
        // abandonment window is safe and releases its quota reservation.
        await deleteStorageUpload({ id: upload.id }).catch(() => undefined);
        abandoned++;
      }
      continue;
    }

    // 取り消しの墓標。抱えているものは何も無いので、消せばそれで終わり——ただし
    // すぐには消さない。これは「まだ現れていない開始」を止めるために置いたもの
    // で、その開始が現れるより先に消すと、止めるつもりだったものが素通りする。
    if (upload.uploadId === "") {
      if (
        upload.createdAt.getTime() >
          now.getTime() - TOMBSTONE_GRACE_MILLISECONDS
      ) {
        continue;
      }

      await deleteStorageUpload({ id: upload.id }).catch(() => undefined);
      abandoned++;
      continue;
    }

    try {
      const bucket = getR2Bucket();
      // A bucket that cannot abandon an upload would leave the row behind for
      // every later run to trip over, so say so once rather than silently.
      if (!bucket.resumeMultipartUpload) {
        throw new Error("The configured R2 bucket cannot abandon an upload.");
      }
      await bucket.resumeMultipartUpload(upload.objectKey, upload.uploadId).abort();
      // 中止できたということは、まだパートのままだった。オブジェクトは無い。
      await deleteStorageUpload({ id: upload.id });
      abandoned++;
    } catch (error) {
      console.error("Failed to abandon a stale storage upload", upload.id, error);
      // An abort failure is not proof that the multipart or a joined object is
      // gone. Keep the cleanup row and its uploadId so a later sweep can retry;
      // deleting the object or declaring success here could destroy a file that
      // completed just before the receipt was committed.
      if (isTerminalMultipartAbortError(error)) {
        // NoSuchUpload is terminal for the multipart handle, but the object may
        // already have been joined before its receipt was written. Only drop
        // the row after confirming that object is absent or deleting it.
        if (await deleteObjectAfterTerminalAbort(upload.objectKey)) {
          await deleteStorageUpload({ id: upload.id }).catch(() => undefined);
          abandoned++;
        } else {
          failed++;
        }
        continue;
      }
      failed++;
    }
  }

  return { abandoned, failed };
}
