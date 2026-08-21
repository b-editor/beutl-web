import {
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
// Long enough that a slow upload of the largest file this service takes is
// never mistaken for an abandoned one.
const ABANDON_AFTER_MILLISECONDS = 24 * 60 * 60 * 1000;
// An abort that fails is worth trying again on the next run, so the row stays.
// It cannot stay for ever, though, or one upload the bucket will never abandon
// would be retried until the end of time; after this long the row is dropped
// and the bucket's own lifecycle rules are what is left.
const GIVE_UP_AFTER_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
const MAX_PER_RUN = 100;

// 追跡行だけがあってレシートの無いキーに、完成したオブジェクトが残っていないか。
// あれば誰も指していないので消す。消せたときだけ true。
async function deleteOrphanedObject(objectKey: string): Promise<boolean> {
  try {
    const bucket = getR2Bucket();
    if (!bucket.head || !bucket.delete) return false;
    const object = await bucket.head(objectKey);
    if (!object) return false;
    await bucket.delete(objectKey);
    return true;
  } catch (error) {
    console.error("Failed to clear an orphaned storage object", objectKey, error);
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
    // いることがある。古い姿のまま進むと、File が指しているオブジェクトを消して
    // しまうので、必ず読み直す。
    const current = await findStorageUploadByIdAndUserId({
      id: upload.id,
      userId: upload.userId,
    }).catch(() => upload);
    if (!current) continue;
    if (current.completedFileId) {
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
      await bucket.resumeMultipartUpload(current.objectKey, current.uploadId).abort();
      // 中止できたということは、まだパートのままだった。オブジェクトは無い。
      await deleteStorageUpload({ id: upload.id });
      abandoned++;
    } catch (error) {
      console.error("Failed to abandon a stale storage upload", upload.id, error);
      // 中止できない理由のひとつは「もう組み上がっている」こと。R2 の結合が
      // 終わったあと、控えを書く前に Worker が落ちるとこうなる。控えが無い＝
      // File は誰も指していないので、残っているオブジェクトはここで消す。
      // これをしないと、追跡できない完成オブジェクトが保管され続ける。
      // ここでもう一度読む。abort を試している間に完了したのなら、そのオブジェクト
      // はもう File のもの。
      const settled = await findStorageUploadByIdAndUserId({
        id: upload.id,
        userId: upload.userId,
      }).catch(() => null);
      if (settled?.completedFileId) {
        await deleteStorageUpload({ id: upload.id }).catch(() => undefined);
        abandoned++;
        continue;
      }

      const orphaned = settled !== null
        && await deleteOrphanedObject(current.objectKey);
      if (orphaned) {
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
