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

import { deleteFile } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/storage/actions";
import { deleteUserFilesWithStorageCleanup } from "@beutl/db";

describe("dashboard storage deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(deleteUserFilesWithStorageCleanup).mockResolvedValue({
      kind: "deleted",
      records: [{ id: "file-1" }],
    } as never);
  });

  it("routes the authenticated owner through the durable delete outbox", async () => {
    await deleteFile(["file-1"]).catch(() => undefined);
    expect(deleteUserFilesWithStorageCleanup).toHaveBeenCalledWith({
      fileIds: ["file-1"],
      userId: "user-1",
    });
  });

  it("does not delete a file that was not returned for the authenticated owner", async () => {
    vi.mocked(deleteUserFilesWithStorageCleanup).mockResolvedValue({
      kind: "notFound",
    } as never);
    await expect(deleteFile(["other-user-file"])).resolves.toMatchObject({ success: false });
  });

  it("rejects the whole selection when a legacy visible file is still referenced", async () => {
    vi.mocked(deleteUserFilesWithStorageCleanup).mockResolvedValue({
      kind: "inUse",
    } as never);
    await expect(deleteFile(["legacy-package-file", "ordinary-file"]))
      .resolves.toMatchObject({
        success: false,
        message: "storage:cannotDeleteFileInUse",
      });
  });
});
