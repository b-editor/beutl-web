import { z } from "zod";
import { isValidStorageName, STORAGE_BATCH_SIZE_MAX } from "@beutl/core";
import {
  createStorageFolder,
  deleteStorageFolderTree,
  deleteUserFilesWithStorageCleanup,
  storageFolderSummary,
  updateOwnedStorageFiles,
  updateOwnedStorageFolder,
} from "@beutl/db";

export type StorageErrorCode =
  | "invalidStorageQuery"
  | "invalidStorageCursor"
  | "invalidRequestBody"
  | "storageFileNotFound"
  | "storageFolderNotFound"
  | "storageFileInUse"
  | "storageFolderInUse"
  | "storageInvalidMove"
  | "storageFolderNotEmpty";
export class StorageOperationError extends Error {
  constructor(public readonly code: StorageErrorCode) {
    super(code);
  }
}

export const storageIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^\u0000-\u001f\u007f/]+$/u);
const nameSchema = z.string().trim().refine(isValidStorageName);
const parentSchema = storageIdSchema.nullable();
export const createFolderSchema = z.object({ name: nameSchema, parentId: parentSchema }).strict();
export const filePatchSchema = z
  .object({
    name: nameSchema.optional(),
    parentId: parentSchema.optional(),
    visibility: z.enum(["PRIVATE", "PUBLIC"]).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
export const folderPatchSchema = z
  .object({ name: nameSchema.optional(), parentId: parentSchema.optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
const idsSchema = z
  .array(storageIdSchema)
  .min(1)
  .max(STORAGE_BATCH_SIZE_MAX)
  .refine((ids) => new Set(ids).size === ids.length);
export const fileBatchSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("move"), ids: idsSchema, parentId: parentSchema }).strict(),
  z
    .object({
      operation: z.literal("visibility"),
      ids: idsSchema,
      visibility: z.enum(["PRIVATE", "PUBLIC"]),
    })
    .strict(),
  z.object({ operation: z.literal("delete"), ids: idsSchema }).strict(),
]);

export function parseStorageInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new StorageOperationError("invalidRequestBody");
  return parsed.data;
}

export async function createManagedFolder(userId: string, input: unknown) {
  const value = parseStorageInput(createFolderSchema, input);
  const result = await createStorageFolder({ userId, ...value });
  if (result.kind !== "created") throw new StorageOperationError("storageFolderNotFound");
  return { id: result.id };
}

export async function updateManagedFolder(userId: string, id: string, input: unknown) {
  parseStorageInput(storageIdSchema, id);
  const patch = parseStorageInput(folderPatchSchema, input);
  const result = await updateOwnedStorageFolder(userId, id, patch);
  if (result.kind === "intoItself") throw new StorageOperationError("storageInvalidMove");
  if (result.kind !== "updated") throw new StorageOperationError("storageFolderNotFound");
}

export async function updateManagedFiles(userId: string, ids: string[], input: unknown) {
  parseStorageInput(idsSchema, ids);
  const patch = parseStorageInput(filePatchSchema, input);
  if (patch.name !== undefined && ids.length !== 1)
    throw new StorageOperationError("invalidRequestBody");
  const result = await updateOwnedStorageFiles(userId, ids, patch);
  if (result.kind === "notFound") throw new StorageOperationError("storageFileNotFound");
  if (result.kind === "targetNotFound") throw new StorageOperationError("storageFolderNotFound");
  if (result.kind === "inUse") throw new StorageOperationError("storageFileInUse");
  return { affected: result.count };
}

export async function deleteManagedFiles(userId: string, ids: string[]) {
  parseStorageInput(idsSchema, ids);
  const result = await deleteUserFilesWithStorageCleanup({ userId, fileIds: ids });
  if (result.kind === "notFound") throw new StorageOperationError("storageFileNotFound");
  if (result.kind === "inUse") throw new StorageOperationError("storageFileInUse");
  return { affected: result.records.length };
}

export async function deleteManagedFolder(userId: string, id: string, recursive: boolean) {
  parseStorageInput(storageIdSchema, id);
  const summary = await storageFolderSummary(userId, id);
  if (!summary) throw new StorageOperationError("storageFolderNotFound");
  if (!recursive && (summary.fileCount || summary.folderCount))
    throw new StorageOperationError("storageFolderNotEmpty");
  const result = await deleteStorageFolderTree({ userId, folderId: id });
  if (result.kind === "inUse") throw new StorageOperationError("storageFolderInUse");
  if (result.kind !== "deleted") throw new StorageOperationError("storageFolderNotFound");
  return { deletedFiles: result.fileCount, deletedFolders: result.folderCount };
}

export async function runManagedFileBatch(userId: string, input: unknown) {
  const request = parseStorageInput(fileBatchSchema, input);
  switch (request.operation) {
    case "delete":
      return deleteManagedFiles(userId, request.ids);
    case "move":
      return updateManagedFiles(userId, request.ids, { parentId: request.parentId });
    case "visibility":
      return updateManagedFiles(userId, request.ids, { visibility: request.visibility });
  }
}
