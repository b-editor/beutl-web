"use server";

import { revalidatePath } from "next/cache";
import { authenticated, throwIfUnauth } from "@/lib/auth-guard";
import type { ActionResult } from "@beutl/core";
import { getLanguage } from "@beutl/next/language";
import { getTranslation } from "@beutl/i18n";
import { deleteStorageFile } from "@/lib/storage";
import {
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
      await deleteStorageFile({
        fileId: file.id,
        userId: session.user.id,
      });
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

export async function retrieveFiles() {
  const session = await throwIfUnauth();
  return await retrieveStorageFilesByUserId({
    userId: session?.user?.id,
  });
}
