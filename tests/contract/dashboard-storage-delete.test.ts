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
vi.mock("@/lib/storage", () => ({ deleteStorageFile: vi.fn() }));
vi.mock("@beutl/db", () => ({
  retrieveFilesByIdsAndUserId: vi.fn(),
  retrieveStorageFilesByUserId: vi.fn(),
  updateFileVisibility: vi.fn(),
}));

import { deleteFile } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/storage/actions";
import { deleteStorageFile } from "../../apps/web/src/lib/storage";
import { retrieveFilesByIdsAndUserId } from "@beutl/db";

describe("dashboard storage deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(retrieveFilesByIdsAndUserId).mockResolvedValue([
      { id: "file-1", userId: "user-1", objectKey: "objects/file-1", visibility: "PRIVATE" },
    ] as never);
    vi.mocked(deleteStorageFile).mockResolvedValue({ id: "file-1" } as never);
  });

  it("routes the authenticated owner through the durable delete outbox", async () => {
    await deleteFile(["file-1"]).catch(() => undefined);
    expect(deleteStorageFile).toHaveBeenCalledWith({
      fileId: "file-1",
      userId: "user-1",
    });
  });

  it("does not delete a file that was not returned for the authenticated owner", async () => {
    vi.mocked(retrieveFilesByIdsAndUserId).mockResolvedValue([]);
    await expect(deleteFile(["other-user-file"])).resolves.toMatchObject({ success: false });
    expect(deleteStorageFile).not.toHaveBeenCalled();
  });
});
