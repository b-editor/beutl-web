"use server";

import { revalidatePath } from "next/cache";
import { authenticated, throwIfUnauth } from "@/lib/auth-guard";
import { STORAGE_QUOTA_BYTES, type ActionResult } from "@beutl/core";
import { getLanguage } from "@beutl/next/language";
import { getTranslation } from "@beutl/i18n";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  createFile,
  deleteFile as deleteFileRecord,
  retrieveFileNamesAndSizesByUserId,
  retrieveFilesByIdsAndUserId,
  retrieveStorageFilesByUserId,
  updateFileVisibility,
} from "@beutl/db";

export async function deleteFile(ids: string[]): Promise<ActionResult> {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);
    const files = await retrieveFilesByIdsAndUserId({
      ids,
      userId: session.user.id,
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
      await deleteFileRecord({
        fileId: file.id,
      });

      const bucket = getCloudflareContext().env.BEUTL_R2_BUCKET;
      await bucket.delete(file.objectKey);
    });
    await Promise.all(promises);

    revalidatePath(`/${lang}/dashboard/storage`);
    return {
      success: true,
    };
  });
}

export async function changeFileVisibility(
  ids: string[],
  visibility: "PRIVATE" | "PUBLIC",
): Promise<ActionResult> {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);
    if (visibility !== "PRIVATE" && visibility !== "PUBLIC") {
      return {
        success: false,
        message: t("invalidRequest"),
      };
    }

    const files = await retrieveFilesByIdsAndUserId({
      ids,
      userId: session.user.id,
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
      await updateFileVisibility({
        fileId: file.id,
        visibility: visibility,
      });
    });
    await Promise.all(promises);

    revalidatePath(`/${lang}/dashboard/storage`);
    return {
      success: true,
    };
  });
}

export async function uploadFile(formData: FormData): Promise<ActionResult> {
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

    const files = await retrieveFileNamesAndSizesByUserId({
      userId: session.user.id,
    });

    const maxSize = BigInt(STORAGE_QUOTA_BYTES);
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
    const contents = await file.arrayBuffer();
    try {
      await bucket.put(objectKey, contents);
      await createFile({
        objectKey,
        name: filename,
        size: file.size,
        mimeType: file.type,
        userId: session.user.id,
        visibility: "PRIVATE",
      });
    } catch (error) {
      try {
        await bucket.delete(objectKey);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Upload failed and the R2 object could not be cleaned up",
        );
      }
      throw error;
    }
    revalidatePath(`/${lang}/dashboard/storage`);
    return {
      success: true,
    };
  });
}

export async function retrieveFiles() {
  const session = await throwIfUnauth();
  return await retrieveStorageFilesByUserId({
    userId: session?.user?.id,
  });
}
