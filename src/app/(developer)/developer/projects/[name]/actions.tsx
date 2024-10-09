"use server";

import { auth } from "@/auth";
import { s3 } from "@/lib/storage";
import { prisma } from "@/prisma";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export type State = {
  errors?: {
    displayName?: string[];
    shortDescription?: string[];
  };
  success?: boolean;
  message?: string | null;
};

const displayNameAndShortDescriptionSchema = z.object({
  displayName: z.string().max(50, "表示名は50文字以下である必要があります"),
  shortDescription: z.string().max(200, "短い説明は200文字以下である必要があります"),
  id: z.string().uuid("IDが不正です"),
});

export async function updateDisplayNameAndShortDescription(state: State, formData: FormData): Promise<State> {
  const session = await auth();
  if (!session?.user?.id) {
    return {
      message: "ログインしてください",
      success: false,
    };
  }

  const validated = displayNameAndShortDescriptionSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!validated.success) {
    return {
      errors: validated.error.flatten().fieldErrors,
      message: "入力内容に誤りがあります",
      success: false,
    };
  }

  const { displayName, shortDescription, id } = validated.data;
  const result = await prisma.package.update({
    where: {
      id,
      userId: session.user.id,
    },
    data: {
      displayName,
      shortDescription,
    }
  });
  revalidatePath(`/developer/projects/${result.name}`);
  return {
    success: true
  };
}

export async function retrievePackage(name: string) {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("ログインしてください");
  }
  const pkg = await prisma.package.findFirst({
    where: {
      name: {
        equals: name,
        mode: "insensitive"
      },
      userId: session?.user?.id
    },
    select: {
      id: true,
      name: true,
      displayName: true,
      description: true,
      shortDescription: true,
      published: true,
      webSite: true,
      tags: true,
      user: {
        select: {
          Profile: {
            select: {
              userName: true,
            }
          }
        }
      },
      iconFile: {
        select: {
          id: true,
          objectKey: true,
        }
      },
      PackageScreenshot: {
        select: {
          order: true,
          file: {
            select: {
              id: true,
              objectKey: true,
            }
          }
        },
        orderBy: {
          order: "asc"
        }
      }
    }
  });
  if (!pkg) {
    return null;
  }

  const screenshots = await Promise.all(pkg.PackageScreenshot.map(async (item) => {
    return {
      ...item,
      url: `/api/contents/${item.file.id}`
    }
  }));

  return {
    ...pkg,
    PackageScreenshot: screenshots
  }
}

export type AddScreenshotResponse = {
  success: boolean;
  message?: string;
}
export async function addScreenshot(formData: FormData): Promise<AddScreenshotResponse> {
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
  const id = formData.get("id") as string;
  const pkg = await prisma.package.findFirst({
    where: { id, userId: session.user.id },
    select: { id: true, name: true }
  });
  if (!pkg) {
    return {
      success: false,
      message: "IDが見つかりません"
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
  const record = await prisma.file.create({
    data: {
      objectKey,
      name: filename,
      size: file.size,
      mimeType: file.type,
      userId: session.user.id,
      visibility: "DEDICATED"
    }
  });
  const lastScreenshot = await prisma.packageScreenshot.findFirst({
    where: {
      packageId: pkg.id
    },
    select: {
      order: true
    },
    orderBy: {
      order: "desc"
    }
  });
  await prisma.packageScreenshot.create({
    data: {
      order: (lastScreenshot?.order || 0) + 1,
      packageId: pkg.id,
      fileId: record.id
    }
  });
  revalidatePath(`/developer/projects/${pkg.name}`);
  return {
    success: true
  }
}

export type MoveScreenshotResponse = {
  success: boolean;
  message?: string;
}

export async function moveScreenshot({ delta, packageId, fileId }: { delta: number, packageId: string, fileId: string }): Promise<MoveScreenshotResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return {
      success: false,
      message: "ログインしてください"
    }
  }
  const pkg = await prisma.package.findFirst({
    where: {
      id: packageId,
      userId: session.user.id,
    },
  });
  if (!pkg) {
    return {
      success: false,
      message: "IDが見つかりません"
    }
  }
  const sign = Math.sign(delta);
  const all = await prisma.packageScreenshot.findMany({
    where: {
      packageId: packageId
    },
    orderBy: {
      order: "asc"
    }
  });

  const target = all.find((screenshot) => screenshot.fileId === fileId);
  if (!target) {
    return {
      success: false,
      message: "ファイルが見つかりません"
    }
  }

  const index = all.indexOf(target);
  if (index === 0 && sign < 0) {
    return {
      success: false,
      message: "既に先頭です"
    }
  }
  if (index === all.length - 1 && sign > 0) {
    return {
      success: false,
      message: "既に末尾です"
    }
  }
  all.splice(index, 1);
  all.splice(index + sign, 0, target);
  const promises = all.map((item, i) => ({ ...item, order: i, originalOrder: item.order }))
    .map(async (item) => {
      if (item.order === item.originalOrder) return;
      await prisma.packageScreenshot.update({
        where: {
          packageId_fileId: {
            packageId: packageId,
            fileId: item.fileId
          }
        },
        data: {
          order: item.order
        }
      });
    });
  await Promise.all(promises);
  revalidatePath(`/developer/projects/${pkg.name}`);
  return {
    success: true
  }
}