import { STORAGE_FILE_NAME_MAX_LENGTH } from "./storage-quota";

export const STORAGE_PAGE_SIZE = 50;
export const STORAGE_PAGE_SIZE_MAX = 100;
export const STORAGE_BATCH_SIZE_MAX = 200;

export function isValidStorageName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= STORAGE_FILE_NAME_MAX_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(name)
  );
}

export type StorageFileAction =
  | "open"
  | "download"
  | "copyLink"
  | "rename"
  | "move"
  | "details"
  | "setPublic"
  | "setPrivate"
  | "delete";

export function storageFileActions(visibility: string): StorageFileAction[] {
  const actions: StorageFileAction[] = ["open", "download"];
  if (visibility === "PUBLIC") actions.push("copyLink");
  if (visibility !== "DEDICATED") actions.push("rename");
  actions.push("move", "details");
  if (visibility === "PRIVATE") actions.push("setPublic");
  if (visibility === "PUBLIC") actions.push("setPrivate");
  if (visibility !== "DEDICATED") actions.push("delete");
  return actions;
}
