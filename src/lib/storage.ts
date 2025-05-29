import "server-only";
import type { PrismaTransaction } from "./db/transaction";
import { createFile, deleteFile, retrieveFilesByUserId } from "./db/file";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export async function deleteStorageFile({
  fileId,
  prisma,
}: {
  fileId: string;
  prisma?: PrismaTransaction;
}) {
  const record = await deleteFile({
    fileId: fileId,
    prisma,
  });
  
  const bucket = (await getCloudflareContext({ async: true })).env.BEUTL_R2_BUCKET;
  bucket.delete(record.objectKey);
  return record;
}

export async function calcTotalFileSize({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const files = await retrieveFilesByUserId({ userId, prisma });
  let totalSize = BigInt(0);
  for (const file of files) {
    totalSize += BigInt(file.size);
  }
  return totalSize;
}

export async function createStorageFile({
  file,
  prisma,
  visibility,
  userId,
}: {
  file: File;
  prisma?: PrismaTransaction;
  visibility: "PUBLIC" | "PRIVATE" | "DEDICATED";
  userId: string;
}) {
  const files = await retrieveFilesByUserId({ userId, prisma });

  let filename = file.name;
  const ext = file.name.split(".").pop();
  for (let i = 1; files.some((f) => f.name === filename); i++) {
    filename = ext
      ? file.name.replace(`.${ext}`, ` (${i}).${ext}`)
      : `${file.name} (${i})`;
  }

  const objectKey = crypto.randomUUID();
  const array = await file.arrayBuffer();
  const bucket = (await getCloudflareContext({ async: true })).env.BEUTL_R2_BUCKET;
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
