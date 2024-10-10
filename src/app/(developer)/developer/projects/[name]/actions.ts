"use server";

import { auth } from "@/auth";
import { s3 } from "@/lib/storage";
import { prisma } from "@/prisma";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
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

export async function updateDescription({ packageId, description }: { packageId: string, description: string }) {
  const session = await auth();
  if (!session?.user?.id) {
    return {
      message: "ログインしてください",
      success: false,
    };
  }

  if (description.length > 1000) {
    return {
      message: "説明は1000文字以下である必要があります",
      success: false,
    };
  }

  const result = await prisma.package.update({
    where: {
      id: packageId,
      userId: session.user.id,
    },
    data: {
      description
    },
    select: {
      name: true
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
    iconFileUrl: pkg.iconFile && `/api/contents/${pkg.iconFile.id}`,
    PackageScreenshot: screenshots
  }
}

export async function deletePackage(id: string) {
  const session = await auth();
  if (!session?.user?.id) {
    return {
      success: false,
      message: "ログインしてください"
    }
  }
  const pkg = await prisma.package.findFirst({
    where: {
      id,
      userId: session.user.id
    },
    select: {
      id: true,
      PackageScreenshot: {
        select: {
          file: {
            select: {
              id: true,
              objectKey: true
            }
          }
        }
      },
      iconFile: {
        select: {
          id: true,
          objectKey: true
        }
      },
      Release: {
        select: {
          file: {
            select: {
              id: true,
              objectKey: true
            }
          }
        }
      }
    }
  });
  if (!pkg) {
    return {
      success: false,
      message: "IDが見つかりません",
    };
  }
  const files = pkg.PackageScreenshot.map((item) => item.file)
    .concat(pkg.Release.map((item) => item.file));
  if (pkg.iconFile) {
    files.push(pkg.iconFile);
  }
  await prisma.package.delete({
    where: {
      id
    }
  });
  const promises = files.map(async (file) => {
    await prisma.file.delete({
      where: {
        id: file.id,
      },
    });
    await s3.send(
      new GetObjectCommand({
        Bucket: process.env.S3_BUCKET as string,
        Key: file.objectKey,
      }),
    );
  });

  await Promise.all(promises);
  revalidatePath("/developer");
  redirect("/developer");
}
export async function changePackageVisibility(id: string, published: boolean) {
  const session = await auth();
  if (!session?.user?.id) {
    return {
      success: false,
      message: "ログインしてください"
    }
  }
  const pkg = await prisma.package.findFirst({
    where: {
      id,
      userId: session.user.id
    }
  });
  if (!pkg) {
    return {
      success: false,
      message: "IDが見つかりません"
    }
  }
  await prisma.package.update({
    where: {
      id
    },
    data: {
      published
    }
  });
  revalidatePath(`/developer/projects/${pkg.name}`);
  return {
    success: true
  }
}

export async function uploadIcon(formData: FormData) {
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
    select: { id: true, name: true, iconFile: { select: { id: true, objectKey: true, size: true } } }
  });
  if (!pkg) {
    return {
      success: false,
      message: "IDが見つかりません"
    }
  }

  let files = await prisma.file.findMany({
    where: {
      userId: session.user.id
    },
    select: {
      size: true,
      name: true,
      id: true
    }
  });
  if (pkg.iconFile) {
    files = files.filter(f => f.id !== pkg.iconFile?.id);
  }

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

  if (pkg.iconFile) {
    await s3.send(new DeleteObjectCommand({
      Bucket: process.env.S3_BUCKET as string,
      Key: pkg.iconFile?.objectKey
    }));
    await prisma.file.delete({
      where: {
        id: pkg.iconFile.id
      }
    });
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
  await prisma.package.update({
    where: {
      id
    },
    data: {
      iconFileId: record.id
    }
  });
  revalidatePath(`/developer/projects/${pkg.name}`);
  return {
    success: true
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

export async function deleteScreenshot({ packageId, fileId }: { packageId: string, fileId: string }) {
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
  await prisma.packageScreenshot.delete({
    where: {
      packageId_fileId: {
        packageId,
        fileId
      }
    }
  });
  await prisma.file.delete({
    where: {
      id: fileId
    }
  });
  revalidatePath(`/developer/projects/${pkg.name}`);
  return {
    success: true
  }
}

export async function updateTag({ packageId, tags }: { packageId: string, tags: string[] }) {
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
  await prisma.package.update({
    where: {
      id: packageId,
    },
    data: {
      tags,
    },
  });
  revalidatePath(`/developer/projects/${pkg.name}`);
  return {
    success: true
  }
}