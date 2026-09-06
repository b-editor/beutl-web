"use server";

import { revalidatePath } from "next/cache";
import { authenticated, throwIfUnauth } from "@/lib/auth-guard";
import type { ActionResult } from "@beutl/core";
import { getLanguage } from "@beutl/next/language";
import { getTranslation } from "@beutl/i18n";
import {
  createStorageFolder,
  deleteStorageFolderTree,
  deleteUserFilesWithStorageCleanup,
  moveStorageFiles,
  moveStorageFolder,
  renameStorageFolder,
  retrieveFilesByIdsAndUserId,
  retrieveStorageFilesByUserId,
  retrieveStorageFoldersByUserId,
  updateFileName,
  updateFileVisibility,
} from "@beutl/db";
import { isValidStorageName } from "./names";

async function translator() {
  const lang = await getLanguage();
  const { t } = await getTranslation(lang);
  return { lang, t };
}

// A folder id arrives from the client as a string or null; anything else
// (empty string, wrong type) means the root.
function folderIdOrRoot(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function deleteFile(ids: string[]): Promise<ActionResult> {
  return await authenticated(async (session) => {
    const { lang, t } = await translator();
    const outcome = await deleteUserFilesWithStorageCleanup({
      fileIds: ids,
      userId: session.user.id,
    });
    if (outcome.kind === "notFound") {
      return {
        success: false,
        message: t("storage:fileNotFound"),
      };
    }
    if (outcome.kind === "inUse") {
      return {
        success: false,
        message: t("storage:cannotDeleteFileInUse"),
      };
    }

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
    const { lang, t } = await translator();
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

export async function renameFile(
  id: string,
  name: string,
): Promise<ActionResult> {
  return await authenticated(async (session) => {
    const { lang, t } = await translator();
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!isValidStorageName(trimmed)) {
      return {
        success: false,
        message: t("storage:invalidFileName"),
      };
    }

    const [file] = await retrieveFilesByIdsAndUserId({
      ids: [id],
      userId: session.user.id,
    });
    if (!file) {
      return {
        success: false,
        message: t("storage:fileNotFound"),
      };
    }
    if (file.visibility === "DEDICATED") {
      return {
        success: false,
        message: t("storage:cannotRenameFileInUse"),
      };
    }

    const renamed = await updateFileName({
      fileId: id,
      userId: session.user.id,
      name: trimmed,
    });
    if (!renamed) {
      return {
        success: false,
        message: t("storage:fileNotFound"),
      };
    }

    revalidatePath(`/${lang}/dashboard/storage`);
    return {
      success: true,
    };
  });
}

export async function moveFiles(
  ids: string[],
  folderId: string | null,
): Promise<ActionResult> {
  return await authenticated(async (session) => {
    const { lang, t } = await translator();
    const outcome = await moveStorageFiles({
      fileIds: Array.isArray(ids) ? ids : [],
      userId: session.user.id,
      folderId: folderIdOrRoot(folderId),
    });
    if (outcome.kind === "targetNotFound") {
      return {
        success: false,
        message: t("storage:folderNotFound"),
      };
    }
    if (outcome.kind === "notFound") {
      return {
        success: false,
        message: t("storage:fileNotFound"),
      };
    }

    revalidatePath(`/${lang}/dashboard/storage`);
    return {
      success: true,
    };
  });
}

export async function createFolder(
  name: string,
  parentId: string | null,
): Promise<ActionResult<{ id: string }>> {
  return await authenticated(async (session) => {
    const { lang, t } = await translator();
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!isValidStorageName(trimmed)) {
      return {
        success: false,
        message: t("storage:invalidFolderName"),
      };
    }

    const outcome = await createStorageFolder({
      userId: session.user.id,
      name: trimmed,
      parentId: folderIdOrRoot(parentId),
    });
    if (outcome.kind === "parentNotFound") {
      return {
        success: false,
        message: t("storage:folderNotFound"),
      };
    }

    revalidatePath(`/${lang}/dashboard/storage`);
    return {
      success: true,
      data: { id: outcome.id },
    };
  });
}

export async function renameFolder(
  id: string,
  name: string,
): Promise<ActionResult> {
  return await authenticated(async (session) => {
    const { lang, t } = await translator();
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!isValidStorageName(trimmed)) {
      return {
        success: false,
        message: t("storage:invalidFolderName"),
      };
    }

    const renamed = await renameStorageFolder({
      folderId: id,
      userId: session.user.id,
      name: trimmed,
    });
    if (!renamed) {
      return {
        success: false,
        message: t("storage:folderNotFound"),
      };
    }

    revalidatePath(`/${lang}/dashboard/storage`);
    return {
      success: true,
    };
  });
}

export async function moveFolder(
  id: string,
  parentId: string | null,
): Promise<ActionResult> {
  return await authenticated(async (session) => {
    const { lang, t } = await translator();
    const outcome = await moveStorageFolder({
      folderId: id,
      userId: session.user.id,
      parentId: folderIdOrRoot(parentId),
    });
    if (outcome.kind === "intoItself") {
      return {
        success: false,
        message: t("storage:cannotMoveFolderIntoItself"),
      };
    }
    if (outcome.kind !== "moved") {
      return {
        success: false,
        message: t("storage:folderNotFound"),
      };
    }

    revalidatePath(`/${lang}/dashboard/storage`);
    return {
      success: true,
    };
  });
}

// Deletes the folder together with everything inside it.
export async function deleteFolder(id: string): Promise<ActionResult> {
  return await authenticated(async (session) => {
    const { lang, t } = await translator();
    const outcome = await deleteStorageFolderTree({
      folderId: id,
      userId: session.user.id,
    });
    if (outcome.kind === "inUse") {
      return {
        success: false,
        message: t("storage:cannotDeleteFolderInUse"),
      };
    }
    if (outcome.kind !== "deleted") {
      return {
        success: false,
        message: t("storage:folderNotFound"),
      };
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

export async function retrieveFolders() {
  const session = await throwIfUnauth();
  return await retrieveStorageFoldersByUserId({
    userId: session?.user?.id,
  });
}
