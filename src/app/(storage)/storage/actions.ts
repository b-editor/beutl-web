"use server";

import { auth } from "@/auth";
import { prisma } from "@/prisma";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3 } from "@/lib/storage";

export type DeleteFileResponse = {
  success: boolean;
  message?: string;
}
export async function deleteFile(ids: string[]) {
  const session = await auth();
  if (!session?.user?.id) {
    return {
      success: false,
      message: "ログインしてください"
    }
  }

  const files = await prisma.file.findMany({
    where: {
      id: {
        in: ids
      },
      userId: session.user.id
    },
    select: {
      objectKey: true,
      id: true,
      visibility: true
    }
  });
  if (!files.length) {
    return {
      success: false,
      message: "ファイルが見つかりません"
    }
  }
  if (files.some(f => f.visibility === "DEDICATED")) {
    return {
      success: false,
      message: "いずれかのファイルは占有されているため削除できません"
    }
  }

  const promises = files.map(async file => {
    await prisma.file.delete({
      where: {
        id: file.id
      }
    });
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET as string, Key: file.objectKey }));
  });
  await Promise.all(promises);

  revalidatePath("/storage");
  return {
    success: true
  }
}

export type ChangeFileVisibilityResponse = {
  success: boolean;
  message?: string;
}
export async function changeFileVisibility(ids: string[], visibility: "PRIVATE" | "PUBLIC") {
  const session = await auth();
  if (!session?.user?.id) {
    return {
      success: false,
      message: "ログインしてください"
    }
  }
  if (visibility !== "PRIVATE" && visibility !== "PUBLIC") {
    return {
      success: false,
      message: "不正な値です"
    }
  }

  const files = await prisma.file.findMany({
    where: {
      id: {
        in: ids
      },
      userId: session.user.id
    },
    select: {
      objectKey: true,
      id: true,
      visibility: true
    }
  });
  if (!files.length) {
    return {
      success: false,
      message: "ファイルが見つかりません"
    }
  }
  if (files.some(f => f.visibility === "DEDICATED")) {
    return {
      success: false,
      message: "いずれかのファイルは占有されています"
    }
  }

  const promises = files.map(async file => {
    await prisma.file.update({
      where: {
        id: file.id
      },
      data: {
        visibility: visibility
      }
    });
  });
  await Promise.all(promises);

  revalidatePath("/storage");
  return {
    success: true
  }
}

export type GetTemporaryUrlResponse = {
  success: boolean;
  message?: string;
  url?: string;
}
export async function getTemporaryUrl(id: string) {
  const session = await auth();
  if (!session?.user?.id) {
    return {
      success: false,
      message: "ログインしてください"
    }
  }

  const file = await prisma.file.findUnique({
    where: {
      id,
      userId: session.user.id
    },
    select: {
      objectKey: true
    }
  });
  if (!file) {
    return {
      success: false,
      message: "ファイルが見つかりません"
    }
  }

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: process.env.S3_BUCKET as string, Key: file.objectKey }),
    { expiresIn: 3600 },
  );
  return {
    success: true,
    url
  }
}

export type UploadFileResponse = {
  success: boolean;
  message?: string;
}
export async function uploadFile(formData: FormData): Promise<UploadFileResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return {
      success: false,
      message: "ログインしてください"
    }
  }
  const file = formData.get("file") as File;
  if (!file) {
    return {
      success: false,
      message: "ファイルが見つかりません"
    }
  }

  const files = await prisma.file.findMany({
    where: {
      userId: session.user.id
    },
    select: {
      size: true,
      name: true
    }
  });

  const maxSize = BigInt(1024 * 1024 * 1024); // 1GB
  let totalSize = BigInt(0);
  for (const file of files) {
    totalSize += BigInt(file.size);
  }

  if (totalSize + BigInt(file.size) > maxSize) {
    return {
      success: false,
      message: "ストレージ容量が足りません"
    }
  }

  let filename = file.name;
  const ext = file.name.split(".").pop();
  for (let i = 1; files.some(f => f.name === filename); i++) {
    filename = ext ? file.name.replace(`.${ext}`, ` (${i}).${ext}`) : `${file.name} (${i})`;
  }

  const objectKey = randomUUID();
  await s3.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET as string,
    Key: objectKey,
    Body: new Uint8Array(await file.arrayBuffer()),
    ServerSideEncryption: "AES256",
  }));
  await prisma.file.create({
    data: {
      objectKey,
      name: filename,
      size: file.size,
      mimeType: file.type,
      userId: session.user.id,
      visibility: "PRIVATE"
    }
  });
  revalidatePath("/storage");
  return {
    success: true
  }
}

export async function retrieveFiles() {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("ログインしてください");
  }
  return await prisma.file.findMany({
    where: {
      userId: session?.user?.id
    },
    select: {
      id: true,
      objectKey: true,
      name: true,
      size: true,
      mimeType: true,
      visibility: true,
    }
  });
}