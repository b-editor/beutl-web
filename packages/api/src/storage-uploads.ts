import {
  deleteStorageUpload,
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
const MAX_PER_RUN = 100;

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
    // 完了済みの控え。パートはもう無いので中止しに行く相手がいない。
    if (upload.completedFileId) {
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
      await deleteStorageUpload({ id: upload.id });
      abandoned++;
    } catch (error) {
      // Already gone is the usual reason, and the row still has to go: what
      // must not happen is one unabortable upload holding up every other.
      console.error("Failed to abandon a stale storage upload", upload.id, error);
      await deleteStorageUpload({ id: upload.id }).catch(() => undefined);
      failed++;
    }
  }

  return { abandoned, failed };
}
