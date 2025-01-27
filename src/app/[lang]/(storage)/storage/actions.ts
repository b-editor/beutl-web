"use server";

import { prisma } from "@/prisma";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { revalidatePath } from "next/cache";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3 } from "@/lib/storage";
import { authenticated, throwIfUnauth } from "@/lib/auth-guard";
import { getLanguage } from "@/lib/lang-utils";
import { getTranslation } from "@/app/i18n/server";

type Response = {
  success: boolean;
  message?: string;
};
export async function deleteFile(ids: string[]): Promise<Response> {
  return await authenticated(async (session) => {
    const lang = getLanguage();
    const { t } = await getTranslation(lang);
    const files = await prisma.file.findMany({
      where: {
        id: {
          in: ids,
        },
        userId: session.user.id,
      },
      select: {
        objectKey: true,
        id: true,
        visibility: true,
      },
    });
    if (!files.length) {
      return {
        success: false,
        message: t("storage:fileNotFound"),
      };
    }
    if (files.some((f) => f.visibility === "DEDICATED")) {
      return {
        success: false,
        message: t("storage:cannotDeleteFileInUse"),
      };
    }

    const promises = files.map(async (file) => {
      await prisma.file.delete({
        where: {
          id: file.id,
        },
      });
      await s3.send(
        new DeleteObjectCommand({
          Bucket: process.env.S3_BUCKET as string,
          Key: file.objectKey,
        }),
      );
    });
    await Promise.all(promises);

    revalidatePath("/storage");
    return {
      success: true,
    };
  });
}

export async function changeFileVisibility(
  ids: string[],
  visibility: "PRIVATE" | "PUBLIC",
): Promise<Response> {
  return await authenticated(async (session) => {
    const lang = getLanguage();
    const { t } = await getTranslation(lang);
    if (visibility !== "PRIVATE" && visibility !== "PUBLIC") {
      return {
        success: false,
        message: t("zod:custom"),
      };
    }

    const files = await prisma.file.findMany({
      where: {
        id: {
          in: ids,
        },
        userId: session.user.id,
      },
      select: {
        objectKey: true,
        id: true,
        visibility: true,
      },
    });
    if (!files.length) {
      return {
        success: false,
        message: t("storage:fileNotFound"),
      };
    }
    if (files.some((f) => f.visibility === "DEDICATED")) {
      return {
        success: false,
        message: t("storage:cannotChangeVisibilityOfFileInUse"),
      };
    }

    const promises = files.map(async (file) => {
      await prisma.file.update({
        where: {
          id: file.id,
        },
        data: {
          visibility: visibility,
        },
      });
    });
    await Promise.all(promises);

    revalidatePath("/storage");
    return {
      success: true,
    };
  });
}

type GetTemporaryUrlResponse = {
  success: boolean;
  message?: string;
  url?: string;
};
export async function getTemporaryUrl(
  id: string,
): Promise<GetTemporaryUrlResponse> {
  return await authenticated(async (session) => {
    const lang = getLanguage();
    const { t } = await getTranslation(lang);
    const file = await prisma.file.findUnique({
      where: {
        id,
        userId: session.user.id,
      },
      select: {
        objectKey: true,
      },
    });
    if (!file) {
      return {
        success: false,
        message: t("storage:fileNotFound"),
      };
    }

    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: process.env.S3_BUCKET as string,
        Key: file.objectKey,
      }),
      { expiresIn: 3600 },
    );
    return {
      success: true,
      url,
    };
  });
}

export async function uploadFile(formData: FormData): Promise<Response> {
  return await authenticated(async (session) => {
    const lang = getLanguage();
    const { t } = await getTranslation(lang);
    const file = formData.get("file") as File;
    if (!file) {
      return {
        success: false,
        message: t("storage:fileNotFound"),
      };
    }

    const files = await prisma.file.findMany({
      where: {
        userId: session.user.id,
      },
      select: {
        size: true,
        name: true,
      },
    });

    const maxSize = BigInt(1024 * 1024 * 1024); // 1GB
    let totalSize = BigInt(0);
    for (const file of files) {
      totalSize += BigInt(file.size);
    }

    if (totalSize + BigInt(file.size) > maxSize) {
      return {
        success: false,
        message: t("storage:insufficientStorageSpace"),
      };
    }

    let filename = file.name;
    const ext = file.name.split(".").pop();
    for (let i = 1; files.some((f) => f.name === filename); i++) {
      filename = ext
        ? file.name.replace(`.${ext}`, ` (${i}).${ext}`)
        : `${file.name} (${i})`;
    }

    const objectKey = crypto.randomUUID();
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET as string,
        Key: objectKey,
        Body: new Uint8Array(await file.arrayBuffer()),
        ServerSideEncryption: "AES256",
      }),
    );
    await prisma.file.create({
      data: {
        objectKey,
        name: filename,
        size: file.size,
        mimeType: file.type,
        userId: session.user.id,
        visibility: "PRIVATE",
      },
    });
    revalidatePath("/storage");
    return {
      success: true,
    };
  });
}

export async function retrieveFiles() {
  const session = await throwIfUnauth();
  return await prisma.file.findMany({
    where: {
      userId: session?.user?.id,
    },
    select: {
      id: true,
      objectKey: true,
      name: true,
      size: true,
      mimeType: true,
      visibility: true,
    },
  });
}
