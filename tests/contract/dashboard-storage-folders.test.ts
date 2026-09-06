import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@beutl/next/language", () => ({ getLanguage: vi.fn(async () => "en") }));
vi.mock("@beutl/i18n", () => ({
  getTranslation: vi.fn(async () => ({ t: (key: string) => key })),
}));
vi.mock("@/lib/auth-guard", () => ({
  authenticated: vi.fn(async (callback: (session: { user: { id: string } }) => unknown) =>
    await callback({ user: { id: "user-1" } })),
  throwIfUnauth: vi.fn(async () => ({ user: { id: "user-1" } })),
}));
vi.mock("@beutl/db", () => ({
  createStorageFolder: vi.fn(),
  deleteStorageFolderTree: vi.fn(),
  deleteUserFilesWithStorageCleanup: vi.fn(),
  moveStorageFiles: vi.fn(),
  moveStorageFolder: vi.fn(),
  renameStorageFolder: vi.fn(),
  retrieveFilesByIdsAndUserId: vi.fn(),
  retrieveStorageFilesByUserId: vi.fn(),
  retrieveStorageFoldersByUserId: vi.fn(),
  updateFileName: vi.fn(),
  updateFileVisibility: vi.fn(),
}));

import {
  createFolder,
  deleteFolder,
  moveFiles,
  moveFolder,
  renameFolder,
} from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/storage/actions";
import {
  createStorageFolder,
  deleteStorageFolderTree,
  moveStorageFiles,
  moveStorageFolder,
  renameStorageFolder,
} from "@beutl/db";

describe("dashboard storage folders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createStorageFolder).mockResolvedValue({ kind: "created", id: "folder-1" });
    vi.mocked(renameStorageFolder).mockResolvedValue(true);
    vi.mocked(moveStorageFolder).mockResolvedValue({ kind: "moved" });
    vi.mocked(moveStorageFiles).mockResolvedValue({ kind: "moved" });
    vi.mocked(deleteStorageFolderTree).mockResolvedValue({
      kind: "deleted",
      fileCount: 2,
      folderCount: 1,
    });
  });

  it("creates a folder under the requested parent for the signed-in owner", async () => {
    await expect(createFolder(" Clips ", "parent-1")).resolves.toMatchObject({
      success: true,
      data: { id: "folder-1" },
    });
    expect(createStorageFolder).toHaveBeenCalledWith({
      userId: "user-1",
      name: "Clips",
      parentId: "parent-1",
    });
  });

  it("treats an empty parent id as the root", async () => {
    await createFolder("Clips", "");
    expect(createStorageFolder).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: null }),
    );
  });

  it("rejects an invalid folder name before touching the database", async () => {
    await expect(createFolder("   ", null)).resolves.toMatchObject({
      success: false,
      message: "storage:invalidFolderName",
    });
    await expect(renameFolder("folder-1", "a".repeat(256))).resolves.toMatchObject({
      success: false,
      message: "storage:invalidFolderName",
    });
    expect(createStorageFolder).not.toHaveBeenCalled();
    expect(renameStorageFolder).not.toHaveBeenCalled();
  });

  it("reports a missing parent", async () => {
    vi.mocked(createStorageFolder).mockResolvedValue({ kind: "parentNotFound" });
    await expect(createFolder("Clips", "gone")).resolves.toMatchObject({
      success: false,
      message: "storage:folderNotFound",
    });
  });

  it("refuses to move a folder into itself or its subtree", async () => {
    vi.mocked(moveStorageFolder).mockResolvedValue({ kind: "intoItself" });
    await expect(moveFolder("folder-1", "folder-1-child")).resolves.toMatchObject({
      success: false,
      message: "storage:cannotMoveFolderIntoItself",
    });
  });

  it("moves files to the root when no folder is given", async () => {
    await expect(moveFiles(["file-1", "file-2"], null)).resolves.toMatchObject({
      success: true,
    });
    expect(moveStorageFiles).toHaveBeenCalledWith({
      fileIds: ["file-1", "file-2"],
      userId: "user-1",
      folderId: null,
    });
  });

  it("reports a missing destination or file when moving", async () => {
    vi.mocked(moveStorageFiles).mockResolvedValue({ kind: "targetNotFound" });
    await expect(moveFiles(["file-1"], "gone")).resolves.toMatchObject({
      success: false,
      message: "storage:folderNotFound",
    });
    vi.mocked(moveStorageFiles).mockResolvedValue({ kind: "notFound" });
    await expect(moveFiles(["other"], null)).resolves.toMatchObject({
      success: false,
      message: "storage:fileNotFound",
    });
  });

  it("deletes a folder tree through the storage cleanup path and surfaces in-use files", async () => {
    await expect(deleteFolder("folder-1")).resolves.toMatchObject({ success: true });
    expect(deleteStorageFolderTree).toHaveBeenCalledWith({
      folderId: "folder-1",
      userId: "user-1",
    });
    vi.mocked(deleteStorageFolderTree).mockResolvedValue({ kind: "inUse" });
    await expect(deleteFolder("folder-1")).resolves.toMatchObject({
      success: false,
      message: "storage:cannotDeleteFolderInUse",
    });
    vi.mocked(deleteStorageFolderTree).mockResolvedValue({ kind: "notFound" });
    await expect(deleteFolder("gone")).resolves.toMatchObject({
      success: false,
      message: "storage:folderNotFound",
    });
  });
});
