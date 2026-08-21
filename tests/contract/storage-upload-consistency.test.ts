import { beforeEach, describe, expect, it, vi } from "vitest";
import { setDbProvider } from "@beutl/db";
import { setR2BucketProvider } from "@beutl/api";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

// What the bucket does with an upload that arrives in parts. The tests below
// are about the order the two halves of a stored file are written in — the
// object and the row that points at it — and what happens when one of them
// fails.
const bucket = vi.hoisted(() => {
  const state = {
    completed: [] as string[],
    deleted: [] as string[],
    deleteFails: false,
    // 結合済みのオブジェクト。head で在ることが分かる。
    objects: new Map<string, number>(),
  };
  return {
    state,
    createMultipartUpload: vi.fn(async () => ({ uploadId: "upload-1" })),
    resumeMultipartUpload: vi.fn((key: string) => ({
      uploadPart: vi.fn(async (partNumber: number) => ({
        partNumber,
        etag: `etag-${partNumber}`,
      })),
      complete: vi.fn(async () => {
        state.completed.push(key);
        return { size: 10 };
      }),
      abort: vi.fn(async () => undefined),
    })),
    head: vi.fn(async (key: string) => {
      const size = state.objects.get(key);
      return size === undefined ? null : { key, size };
    }),
    delete: vi.fn(async (key: string) => {
      if (state.deleteFails) throw new Error("the object could not be deleted");
      state.deleted.push(key);
      state.objects.delete(key);
    }),
  };
});

const createFile = vi.hoisted(() => vi.fn());
const claimStorageUploadForAbandon = vi.hoisted(() => vi.fn());
vi.mock("@beutl/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@beutl/db")>();
  return { ...actual, createFile, claimStorageUploadForAbandon };
});

import { finishUpload, startUpload } from "../../apps/web/src/lib/storage-upload-server";

const USER_ID = "user-consistency";

async function begin() {
  const started = await startUpload({
    userId: USER_ID,
    id: crypto.randomUUID(),
    name: "clip.mp4",
    mimeType: "video/mp4",
    size: BigInt(10),
  });
  if (!started.ok) throw new Error(started.reason);
  return started.upload.id;
}

describe("storage upload consistency", () => {
  let state: ReturnType<typeof createInMemoryPrisma>["state"];

  beforeEach(() => {
    vi.clearAllMocks();
    bucket.state.completed.length = 0;
    bucket.state.deleted.length = 0;
    bucket.state.deleteFails = false;
    bucket.state.objects.clear();
    const memory = createInMemoryPrisma();
    state = memory.state;
    setDbProvider(async () => memory.prisma as never);
    setR2BucketProvider(() => bucket as never);
    createFile.mockImplementation(async () => ({
      id: "file-1",
      name: "clip.mp4",
    }));
    claimStorageUploadForAbandon.mockImplementation(async () => true);
  });

  it("waits for the bucket to join the parts before recording the file", async () => {
    const uploadId = await begin();

    await finishUpload({
      userId: USER_ID,
      uploadId,
      parts: [{ partNumber: 1, etag: "etag-1" }],
    });

    // A row written first would point at a file the bucket may never finish.
    expect(bucket.state.completed).toHaveLength(1);
    expect(createFile).toHaveBeenCalledOnce();
    const completedAt = bucket.resumeMultipartUpload.mock.invocationCallOrder[0];
    expect(createFile.mock.invocationCallOrder[0]).toBeGreaterThan(completedAt);
  });

  it("records nothing when the parts cannot be joined", async () => {
    const uploadId = await begin();
    bucket.resumeMultipartUpload.mockImplementationOnce(() => ({
      uploadPart: vi.fn(),
      complete: vi.fn(async () => {
        throw new Error("a part is missing");
      }),
      abort: vi.fn(async () => undefined),
    }));

    const outcome = await finishUpload({
      userId: USER_ID,
      uploadId,
      parts: [{ partNumber: 1, etag: "etag-1" }],
    });

    expect(outcome).toEqual({ ok: false, reason: "uploadFailed" });
    expect(createFile).not.toHaveBeenCalled();
    // Nothing is left holding storage.
    expect(state.storageUploads.size).toBe(0);
  });

  it("throws away the object when the file cannot be recorded", async () => {
    const uploadId = await begin();
    createFile.mockRejectedValueOnce(new Error("the database is unavailable"));

    await expect(
      finishUpload({
        userId: USER_ID,
        uploadId,
        parts: [{ partNumber: 1, etag: "etag-1" }],
      }),
    ).rejects.toThrow("the database is unavailable");

    // An object nothing points at is stored, and paid for, for nothing.
    expect(bucket.state.deleted).toHaveLength(1);
    // The row stays. The transaction rolled back, so it wrote no receipt, and
    // the row is what lets the sweep find this upload at all.
    const [remaining] = [...state.storageUploads.values()];
    expect(remaining?.completedFileId ?? null).toBeNull();
  });

  it("finishes an upload the bucket had already joined", async () => {
    const uploadId = await begin();
    const [tracked] = [...state.storageUploads.values()];
    // 結合は済んだのに、控えを書く前に落ちた。R2 は結合済みのアップロード id を
    // 忘れるので、やり直すと complete が失敗する——それを「届かなかった」と
    // 読むと、送った側は何度送っても同じところで止まり、24 時間後に掃除が
    // そのオブジェクトを消す。
    bucket.state.objects.set(tracked!.objectKey, 10);
    bucket.resumeMultipartUpload.mockImplementationOnce(() => ({
      uploadPart: vi.fn(),
      complete: vi.fn(async () => {
        throw new Error("no such upload");
      }),
      abort: vi.fn(async () => undefined),
    }));

    const outcome = await finishUpload({
      userId: USER_ID,
      uploadId,
      parts: [{ partNumber: 1, etag: "etag-1" }],
    });

    expect(outcome).toEqual({
      ok: true,
      file: { id: "file-1", name: "clip.mp4", size: BigInt(10) },
    });
    expect(createFile).toHaveBeenCalledOnce();
    expect(bucket.state.deleted).toHaveLength(0);
  });

  it("refuses to record a file for an upload the sweep has claimed", async () => {
    const uploadId = await begin();
    const [tracked] = [...state.storageUploads.values()];
    // 掃除が「このパートは自分が捨てる」と宣言済み。ここで控えを書くと、消される
    // 予定のオブジェクトを File が指すことになる。
    state.storageUploads.set(tracked!.id, {
      ...tracked!,
      abandonedAt: new Date(),
    });

    const outcome = await finishUpload({
      userId: USER_ID,
      uploadId,
      parts: [{ partNumber: 1, etag: "etag-1" }],
    });

    expect(outcome).toEqual({ ok: false, reason: "uploadFailed" });
    expect(createFile).not.toHaveBeenCalled();
  });

  it("leaves the object alone when the row is not this call's to clear", async () => {
    // 取引が失敗したあとに控えが見えないのは、「書かれなかった」とは限らない
    // ——同じアップロードを仕上げている別の呼び出しが、まだ commit していない
    // だけかもしれない。行を取れなければ、このオブジェクトはこの呼び出しのもの
    // ではない。消すと、直後に記録される File が消えたものを指すことになる。
    const uploadId = await begin();
    createFile.mockRejectedValueOnce(new Error("the database is unavailable"));
    claimStorageUploadForAbandon.mockResolvedValueOnce(false);

    await expect(
      finishUpload({
        userId: USER_ID,
        uploadId,
        parts: [{ partNumber: 1, etag: "etag-1" }],
      }),
    ).rejects.toThrow("the database is unavailable");

    expect(bucket.state.deleted).toHaveLength(0);
    // 行も残る。掃除だけが、これを片付けてよいかを決められる。
    expect(state.storageUploads.size).toBe(1);
  });

  it("reports both failures when the object cannot be thrown away either", async () => {
    const uploadId = await begin();
    createFile.mockRejectedValueOnce(new Error("the database is unavailable"));
    bucket.state.deleteFails = true;

    const error = await finishUpload({
      userId: USER_ID,
      uploadId,
      parts: [{ partNumber: 1, etag: "etag-1" }],
    }).catch((reason: unknown) => reason);

    // The object is still there and the caller is told why, rather than the
    // cleanup failure hiding what actually went wrong.
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((item) => (item as Error).message))
      .toEqual([
        "the database is unavailable",
        "the object could not be deleted",
      ]);
  });
});
