import { createRequire } from "node:module";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticated: vi.fn(),
  bucketDelete: vi.fn(),
  bucketPut: vi.fn(),
  createFile: vi.fn(),
  getLanguage: vi.fn(),
  getTranslation: vi.fn(),
  revalidatePath: vi.fn(),
  retrieveFileNamesAndSizesByUserId: vi.fn(),
  throwIfUnauth: vi.fn(),
}));

vi.mock("@/lib/auth-guard", () => ({
  authenticated: mocks.authenticated,
  throwIfUnauth: mocks.throwIfUnauth,
}));
vi.mock("@beutl/next/language", () => ({
  getLanguage: mocks.getLanguage,
}));
vi.mock("@beutl/i18n", () => ({
  getTranslation: mocks.getTranslation,
}));
vi.mock("@beutl/db", () => ({
  createFile: mocks.createFile,
  deleteFile: vi.fn(),
  retrieveFileNamesAndSizesByUserId:
    mocks.retrieveFileNamesAndSizesByUserId,
  retrieveFilesByIdsAndUserId: vi.fn(),
  retrieveStorageFilesByUserId: vi.fn(),
  updateFileVisibility: vi.fn(),
}));
type UploadFile =
  typeof import("../../apps/web/src/app/[lang]/(dashboard)/dashboard/storage/actions").uploadFile;

let uploadFile: UploadFile;

beforeAll(async () => {
  const requireFromWeb = createRequire(
    new URL("../../apps/web/package.json", import.meta.url),
  );
  vi.doMock(requireFromWeb.resolve("@opennextjs/cloudflare"), () => ({
    getCloudflareContext: () => ({
      env: {
        BEUTL_R2_BUCKET: {
          delete: mocks.bucketDelete,
          put: mocks.bucketPut,
        },
      },
    }),
  }));
  vi.doMock(requireFromWeb.resolve("next/cache"), () => ({
    revalidatePath: mocks.revalidatePath,
  }));
  ({ uploadFile } = await import(
    "../../apps/web/src/app/[lang]/(dashboard)/dashboard/storage/actions"
  ));
});

function uploadForm() {
  const formData = new FormData();
  formData.set(
    "file",
    new File([new Uint8Array([1, 2, 3])], "image.png", {
      type: "image/png",
    }),
  );
  return formData;
}

describe("storage upload consistency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticated.mockImplementation(
      async (callback: (session: { user: { id: string } }) => Promise<unknown>) =>
        await callback({ user: { id: "user-1" } }),
    );
    mocks.getLanguage.mockResolvedValue("en");
    mocks.getTranslation.mockResolvedValue({ t: (key: string) => key });
    mocks.retrieveFileNamesAndSizesByUserId.mockResolvedValue([]);
    mocks.bucketPut.mockResolvedValue({});
    mocks.bucketDelete.mockResolvedValue(undefined);
    mocks.createFile.mockResolvedValue({ id: "file-1" });
  });

  it("waits for R2 before creating the database record", async () => {
    let finishPut: (() => void) | undefined;
    mocks.bucketPut.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          finishPut = resolve;
        }),
    );

    const upload = uploadFile(uploadForm());
    await vi.waitFor(() => expect(mocks.bucketPut).toHaveBeenCalledOnce());

    expect(mocks.createFile).not.toHaveBeenCalled();
    finishPut?.();
    await expect(upload).resolves.toEqual({ success: true });
    expect(mocks.createFile).toHaveBeenCalledOnce();
    expect(mocks.bucketPut.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createFile.mock.invocationCallOrder[0],
    );
  });

  it("does not create a database record when the R2 put fails", async () => {
    const putError = new Error("R2 unavailable");
    mocks.bucketPut.mockRejectedValueOnce(putError);

    await expect(uploadFile(uploadForm())).rejects.toBe(putError);

    expect(mocks.createFile).not.toHaveBeenCalled();
    expect(mocks.bucketDelete).toHaveBeenCalledWith(
      mocks.bucketPut.mock.calls[0][0],
    );
  });

  it("deletes the R2 object when database creation fails", async () => {
    const databaseError = new Error("database unavailable");
    mocks.createFile.mockRejectedValueOnce(databaseError);

    await expect(uploadFile(uploadForm())).rejects.toBe(databaseError);

    expect(mocks.bucketDelete).toHaveBeenCalledWith(
      mocks.bucketPut.mock.calls[0][0],
    );
  });

  it("reports both failures when compensating deletion also fails", async () => {
    const databaseError = new Error("database unavailable");
    const cleanupError = new Error("R2 delete unavailable");
    mocks.createFile.mockRejectedValueOnce(databaseError);
    mocks.bucketDelete.mockRejectedValueOnce(cleanupError);

    const error = await uploadFile(uploadForm()).catch((reason) => reason);

    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([databaseError, cleanupError]);
  });
});
