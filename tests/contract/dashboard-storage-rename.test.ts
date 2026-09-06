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

import { renameFile } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/storage/actions";
import { isValidStorageName } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/storage/names";
import { retrieveFilesByIdsAndUserId, updateFileName } from "@beutl/db";

describe("dashboard storage rename", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(retrieveFilesByIdsAndUserId).mockResolvedValue([
      { id: "file-1", objectKey: "k", visibility: "PRIVATE" },
    ] as never);
    vi.mocked(updateFileName).mockResolvedValue(true);
  });

  it("renames a file the owner holds, with surrounding whitespace trimmed", async () => {
    await expect(renameFile("file-1", "  clip.mp4 ")).resolves.toMatchObject({
      success: true,
    });
    expect(updateFileName).toHaveBeenCalledWith({
      fileId: "file-1",
      userId: "user-1",
      name: "clip.mp4",
    });
  });

  it("rejects an empty, overlong or control-character name before touching the database", async () => {
    for (const name of ["", "   ", "a".repeat(256), "bad\tname"]) {
      await expect(renameFile("file-1", name)).resolves.toMatchObject({
        success: false,
        message: "storage:invalidFileName",
      });
    }
    expect(updateFileName).not.toHaveBeenCalled();
  });

  it("does not rename a file that was not returned for the authenticated owner", async () => {
    vi.mocked(retrieveFilesByIdsAndUserId).mockResolvedValue([] as never);
    await expect(renameFile("other-user-file", "x.png")).resolves.toMatchObject({
      success: false,
      message: "storage:fileNotFound",
    });
    expect(updateFileName).not.toHaveBeenCalled();
  });

  it("refuses to rename a dedicated file", async () => {
    vi.mocked(retrieveFilesByIdsAndUserId).mockResolvedValue([
      { id: "file-1", objectKey: "k", visibility: "DEDICATED" },
    ] as never);
    await expect(renameFile("file-1", "icon.png")).resolves.toMatchObject({
      success: false,
      message: "storage:cannotRenameFileInUse",
    });
    expect(updateFileName).not.toHaveBeenCalled();
  });

  it("reports the file as gone when the row vanished between the check and the update", async () => {
    vi.mocked(updateFileName).mockResolvedValue(false);
    await expect(renameFile("file-1", "x.png")).resolves.toMatchObject({
      success: false,
      message: "storage:fileNotFound",
    });
  });

  it("validates names the same way the dialog does", () => {
    expect(isValidStorageName("a.png")).toBe(true);
    expect(isValidStorageName("a".repeat(255))).toBe(true);
    expect(isValidStorageName("")).toBe(false);
    expect(isValidStorageName("a".repeat(256))).toBe(false);
    expect(isValidStorageName("a\tb")).toBe(false);
  });
});
