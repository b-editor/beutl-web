"use server";

import { revalidatePath } from "next/cache";
import { authenticated, throwIfUnauth } from "@/lib/auth-guard";
import { STORAGE_LIST_PAGE_SIZE, type ActionResult, type StorageListingParams } from "@beutl/core";
import { getLanguage } from "@beutl/next/language";
import { getTranslation } from "@beutl/i18n";
import {
  countStorageFilesInFolders,
  retrieveStorageFilesPage,
  retrieveStorageFoldersByUserId,
} from "@beutl/db";
import {
  StorageOperationError,
  type StorageErrorCode,
  createManagedFolder,
  updateManagedFolder,
  updateManagedFiles,
  deleteManagedFiles,
  deleteManagedFolder,
} from "@beutl/api/storage/management";

const errorMessages: Record<StorageErrorCode, string> = {
  invalidRequestBody: "invalidRequest",
  invalidStorageQuery: "invalidRequest",
  invalidStorageCursor: "invalidRequest",
  storageFileNotFound: "storage:fileNotFound",
  storageFolderNotFound: "storage:folderNotFound",
  storageFileInUse: "storage:cannotDeleteFileInUse",
  storageFolderInUse: "storage:cannotDeleteFolderInUse",
  storageInvalidMove: "storage:cannotMoveFolderIntoItself",
  storageFolderNotEmpty: "storage:cannotDeleteFolderInUse",
};

async function mutation<T>(
  run: (userId: string) => Promise<T>,
  messages: Partial<Record<StorageErrorCode, string>> = {},
): Promise<ActionResult<T>> {
  return authenticated(async (session) => {
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);
    try {
      const data = await run(session.user.id);
      revalidatePath(`/${lang}/dashboard/storage`);
      return { success: true, data };
    } catch (error) {
      if (!(error instanceof StorageOperationError)) throw error;
      return { success: false, message: t(messages[error.code] ?? errorMessages[error.code]) };
    }
  });
}

async function change(
  run: (userId: string) => Promise<unknown>,
  messages: Partial<Record<StorageErrorCode, string>> = {},
): Promise<ActionResult> {
  return mutation(async (userId) => {
    await run(userId);
    return undefined;
  }, messages);
}

export async function deleteFile(ids: string[]): Promise<ActionResult> {
  return change((userId) => deleteManagedFiles(userId, ids));
}
export async function changeFileVisibility(
  ids: string[],
  visibility: "PRIVATE" | "PUBLIC",
): Promise<ActionResult> {
  return change((userId) => updateManagedFiles(userId, ids, { visibility }), {
    storageFileInUse: "storage:cannotChangeVisibilityOfFileInUse",
  });
}
export async function renameFile(id: string, name: string): Promise<ActionResult> {
  return change((userId) => updateManagedFiles(userId, [id], { name }), {
    invalidRequestBody: "storage:invalidFileName",
    storageFileInUse: "storage:cannotRenameFileInUse",
  });
}
export async function moveFiles(ids: string[], folderId: string | null): Promise<ActionResult> {
  return change((userId) => updateManagedFiles(userId, ids, { parentId: folderId }));
}
export async function createFolder(
  name: string,
  parentId: string | null,
): Promise<ActionResult<{ id: string }>> {
  return mutation((userId) => createManagedFolder(userId, { name, parentId }), {
    invalidRequestBody: "storage:invalidFolderName",
  });
}
export async function renameFolder(id: string, name: string): Promise<ActionResult> {
  return change((userId) => updateManagedFolder(userId, id, { name }), {
    invalidRequestBody: "storage:invalidFolderName",
  });
}
export async function moveFolder(id: string, parentId: string | null): Promise<ActionResult> {
  return change((userId) => updateManagedFolder(userId, id, { parentId }));
}
export async function deleteFolder(id: string): Promise<ActionResult> {
  return change((userId) => deleteManagedFolder(userId, id, true));
}

export async function retrieveFilesPage(listing: StorageListingParams) {
  const session = await throwIfUnauth();
  return retrieveStorageFilesPage({
    userId: session.user.id,
    listing,
    pageSize: STORAGE_LIST_PAGE_SIZE,
  });
}
export async function countFilesInFolders(folderIds: string[]): Promise<number> {
  const session = await throwIfUnauth();
  return countStorageFilesInFolders({
    userId: session.user.id,
    folderIds: folderIds.filter((id) => typeof id === "string" && id.length > 0),
  });
}
export async function retrieveFolders() {
  const session = await throwIfUnauth();
  return retrieveStorageFoldersByUserId({ userId: session.user.id });
}
