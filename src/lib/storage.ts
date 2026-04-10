import "server-only";
import type { DbTransaction } from "./db/transaction";
import { createFile, deleteFile, retrieveFilesByUserId } from "./db/file";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export async function deleteStorageFile({
  fileId,
  tx,
}: {
  fileId: string;
  tx?: DbTransaction;
}) {
  const record = await deleteFile({
    fileId: fileId,
    tx,
  });

  const bucket = getCloudflareContext().env.BEUTL_R2_BUCKET;
  bucket.delete(record.objectKey);
  return record;
}

export async function calcTotalFileSize({
  userId,
  tx,
}: {
  userId: string;
  tx?: DbTransaction;
}) {
  const files = await retrieveFilesByUserId({ userId, tx });
  let totalSize = BigInt(0);
  for (const file of files) {
    totalSize += BigInt(file.size);
  }
  return totalSize;
}

export async function createStorageFile({
  file,
  tx,
  visibility,
  userId,
}: {
  file: File;
  tx?: DbTransaction;
  visibility: "PUBLIC" | "PRIVATE" | "DEDICATED";
  userId: string;
}) {
  const files = await retrieveFilesByUserId({ userId, tx });

  let filename = file.name;
  const ext = file.name.split(".").pop();
  for (let i = 1; files.some((f) => f.name === filename); i++) {
    filename = ext
      ? file.name.replace(`.${ext}`, ` (${i}).${ext}`)
      : `${file.name} (${i})`;
  }

  const objectKey = crypto.randomUUID();
  const array = await file.arrayBuffer();
  const bucket = getCloudflareContext().env.BEUTL_R2_BUCKET;
  bucket.put(
    objectKey,
    array,
  );
  // sha256を計算
  const hashBuffer = await crypto.subtle.digest("SHA-256", array);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return await createFile({
    objectKey,
    name: filename,
    size: file.size,
    mimeType: file.type,
    userId: userId,
    visibility: visibility,
    sha256: hashHex,
  });
}
