import "server-only";
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { PrismaTransaction } from "./db/transaction";
import { createFile, deleteFile, retrieveFilesByUserId } from "./db/file";

export const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT as string,
  region: process.env.S3_REGION as string,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID as string,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY as string,
  },
});

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
  await s3.send(
    new DeleteObjectCommand({
      Bucket: process.env.S3_BUCKET as string,
      Key: record.objectKey,
    }),
  );
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
  const array = new Uint8Array(await file.arrayBuffer());
  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET as string,
      Key: objectKey,
      Body: array,
      ServerSideEncryption: "AES256",
    }),
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
