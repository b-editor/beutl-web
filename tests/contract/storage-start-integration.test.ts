import { beforeEach, describe, expect, it, vi } from "vitest";
import { setDbProvider } from "@beutl/db";
import { setR2BucketProvider } from "@beutl/api";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const attach = vi.hoisted(() => vi.fn());
vi.mock("@beutl/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@beutl/db")>()),
  attachStorageUploadRemote: attach,
}));

import { startUpload } from "../../apps/web/src/lib/storage-upload-server";

describe("startUpload remote attach saga", () => {
  const create = vi.fn(async (key: string) => ({ uploadId: "remote-1", key }));
  const abort = vi.fn(async () => undefined);
  const bucket = {
    createMultipartUpload: create,
    resumeMultipartUpload: vi.fn(() => ({ abort })),
  };
  let state: ReturnType<typeof createInMemoryPrisma>["state"];

  beforeEach(() => {
    vi.clearAllMocks();
    const memory = createInMemoryPrisma();
    state = memory.state;
    setDbProvider(async () => memory.prisma as never);
    setR2BucketProvider(() => bucket as never);
    attach.mockReset();
  });

  const request = () => startUpload({
    userId: "integration-user",
    id: crypto.randomUUID(),
    name: "integration.bin",
    mimeType: "application/octet-stream",
    size: BigInt(10),
  });

  it("retries a transient attach and returns only after it succeeds", async () => {
    attach.mockRejectedValueOnce(new Error("temporary database failure"));
    attach.mockResolvedValue(true);
    await expect(request()).resolves.toMatchObject({ ok: true });
    expect(create).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledTimes(2);
  });

  it("retains the exact remote handle when attach loses the CAS", async () => {
    attach.mockResolvedValue(false);
    await expect(request()).rejects.toThrow("could not be durably attached");
    expect(abort).not.toHaveBeenCalled();
    expect([...state.storageUploads.values()][0]?.uploadId).toBe("remote-1");
  });

  it("surfaces an attach and abort failure without false success", async () => {
    attach.mockResolvedValue(false);
    abort.mockRejectedValue(new Error("bucket unavailable"));
    await expect(request()).rejects.toThrow("could not be durably attached");
    expect(abort).not.toHaveBeenCalled();
    expect([...state.storageUploads.values()][0]?.uploadId).toBe("remote-1");
  });

});
