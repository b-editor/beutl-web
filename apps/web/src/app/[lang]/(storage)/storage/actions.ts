"use server";

import { revalidatePath } from "next/cache";
import { authenticated, throwIfUnauth } from "@/lib/auth-guard";
import type { ActionResult } from "@beutl/core";
import { getLanguage } from "@beutl/next/language";
import { getTranslation } from "@beutl/i18n";
import { createStorageFile, drainStorageCleanup } from "@/lib/storage";
import {
  enqueueFilesCleanup,
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

    const queued = await enqueueFilesCleanup({
      fileIds: files.map((file) => file.id),
    });
    if (!queued) {
      return {
        success: false,
        message: t("storage:cannotDeleteFileInUse"),
      };
    }
    await drainStorageCleanup();

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

    await createStorageFile({
      file,
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
