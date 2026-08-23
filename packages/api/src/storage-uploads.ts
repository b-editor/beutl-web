import {
  claimStorageUploadForAbandon,
  deleteStorageUpload,
  findStorageUploadByIdAndUserId,
  listStorageUploadsStartedBefore,
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
// An abort that fails is worth trying again on the next run, so the row stays.
// It cannot stay for ever, though, or one upload the bucket will never abandon
// would be retried until the end of time; after this long the row is dropped
// and the bucket's own lifecycle rules are what is left.
const GIVE_UP_AFTER_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
const MAX_PER_RUN = 100;

// 取った行のキーに、完成したオブジェクトが残っていないか。
//
//  - deleted: 残っていたので消した。
//  - absent: 何も残っていない。取った行なので控えも書けず、片付けるものは無い。
//  - unknown: 確かめられなかった。残っているかもしれないので、行は残す。
type OrphanedObject = "deleted" | "absent" | "unknown";

async function clearOrphanedObject(objectKey: string): Promise<OrphanedObject> {
  try {
    const bucket = getR2Bucket();
    if (!bucket.head || !bucket.delete) return "unknown";
    const object = await bucket.head(objectKey);
    if (!object) return "absent";
    await bucket.delete(objectKey);
    return "deleted";
  } catch (error) {
    console.error("Failed to clear an orphaned storage object", objectKey, error);
    return "unknown";
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
        await deleteStorageUpload({ id: upload.id }).catch(() => undefined);
        abandoned++;
        continue;
      }
      if (!current.abandonedAt) continue;
    }

    // 取り消しの墓標。抱えているものは何も無いので、消せばそれで終わり。
    if (upload.uploadId === "") {
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
      // 中止できない理由のひとつは「もう組み上がっている」こと。R2 の結合が
      // 終わったあと、控えを書く前に Worker が落ちるとこうなる。行はこちらの
      // ものなので控えはもう書けない＝ File は誰も指していない。残っている
      // オブジェクトはここで消す——これをしないと、追跡できない完成オブジェクト
      // が保管され続ける。何も残っていなかったのなら、この行が指していたものは
      // もう無い。どちらの場合も行は用済みで、残しても次の回で同じところに来る
      // だけになる。
      if (await clearOrphanedObject(upload.objectKey) !== "unknown") {
        await deleteStorageUpload({ id: upload.id }).catch(() => undefined);
        abandoned++;
        continue;
      }

      if (
        upload.createdAt.getTime() <=
          now.getTime() - GIVE_UP_AFTER_MILLISECONDS
      ) {
        await deleteStorageUpload({ id: upload.id }).catch(() => undefined);
      }
      failed++;
    }
  }

  return { abandoned, failed };
}
