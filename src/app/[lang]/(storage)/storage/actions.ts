"use server";

import { getDbAsync } from "@/prisma";
import { revalidatePath } from "next/cache";
import { authenticated, throwIfUnauth } from "@/lib/auth-guard";
import { getLanguage } from "@/lib/lang-utils";
import { getTranslation } from "@/app/i18n/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";

type Response = {
  success: boolean;
  message?: string;
};
export async function deleteFile(ids: string[]): Promise<Response> {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);
    const db = await getDbAsync();
    const files = await db.file.findMany({
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
      const db = await getDbAsync();
  await db.file.delete({
        where: {
          id: file.id,
        },
      });

      const bucket = getCloudflareContext().env.BEUTL_R2_BUCKET;
      await bucket.delete(file.objectKey);
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
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);
    if (visibility !== "PRIVATE" && visibility !== "PUBLIC") {
      return {
        success: false,
        message: t("zod:custom"),
      };
    }

    const db = await getDbAsync();
    const files = await db.file.findMany({
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
      const db = await getDbAsync();
  await db.file.update({
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

export async function uploadFile(formData: FormData): Promise<Response> {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);
    const file = formData.get("file") as File;
    if (!file) {
      return {
        success: false,
        message: t("storage:fileNotFound"),
      };
    }

    const db = await getDbAsync();
    const files = await db.file.findMany({
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
    const bucket = getCloudflareContext().env.BEUTL_R2_BUCKET;
    bucket.put(
      objectKey,
      await file.arrayBuffer(),
    );
    await db.file.create({
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
  const db = await getDbAsync();
  return await db.file.findMany({
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
