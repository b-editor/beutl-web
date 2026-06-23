"use server";

import { revalidatePath } from "next/cache";
import { authenticated, throwIfUnauth } from "@/lib/auth-guard";
import type { ActionResult } from "@/lib/action-result";
import { getLanguage } from "@/lib/lang-utils";
import { getTranslation } from "@/app/i18n/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  createFile,
  deleteFile as deleteFileRecord,
  retrieveFileNamesAndSizesByUserId,
  retrieveFilesByIdsAndUserId,
  retrieveStorageFilesByUserId,
  updateFileVisibility,
} from "@/lib/db/file";

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

    revalidatePath(`/${lang}/storage`);
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
        message: t("zod:custom"),
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

    revalidatePath(`/${lang}/storage`);
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
    await createFile({
      objectKey,
      name: filename,
      size: file.size,
      mimeType: file.type,
      userId: session.user.id,
      visibility: "PRIVATE",
    });
    revalidatePath(`/${lang}/storage`);
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
