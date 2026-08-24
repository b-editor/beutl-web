import { beforeEach, describe, expect, it, vi } from "vitest";
import { setDbProvider } from "@beutl/db";
import { setR2BucketProvider } from "@beutl/api";
import {
  STORAGE_FILE_COUNT_LIMIT,
  STORAGE_QUOTA_BYTES,
  STORAGE_UPLOAD_PART_BYTES,
} from "@beutl/core";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

// The bucket a file is assembled in. R2 keeps the parts under an upload id and
// joins them when told to, which is what lets a file arrive as several requests.
const bucket = vi.hoisted(() => {
  const uploads = new Map<
    string,
    { key: string; parts: Map<number, number>; aborted: boolean }
  >();
  let nextId = 1;
  return {
    uploads,
    createMultipartUpload: vi.fn(async (key: string) => {
      const uploadId = `upload-${nextId++}`;
      uploads.set(uploadId, { key, parts: new Map(), aborted: false });
      return {
        uploadId,
        uploadPart: vi.fn(),
        complete: vi.fn(),
        abort: vi.fn(),
      };
    }),
    resumeMultipartUpload: vi.fn((key: string, uploadId: string) => ({
      uploadPart: async (partNumber: number, body: ReadableStream<Uint8Array>) => {
        const upload = uploads.get(uploadId);
        if (!upload || upload.key !== key) throw new Error("no such upload");
        let size = 0;
        const reader = body.getReader();
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
        }
        upload.parts.set(partNumber, size);
        return { partNumber, etag: `etag-${partNumber}` };
      },
      complete: async (parts: { partNumber: number; etag: string }[]) => {
        const upload = uploads.get(uploadId);
        if (!upload) throw new Error("no such upload");
        let size = 0;
        for (const part of parts) {
          const partSize = upload.parts.get(part.partNumber);
          if (partSize === undefined) throw new Error("missing part");
          size += partSize;
        }
        return { size };
      },
      abort: async () => {
        const upload = uploads.get(uploadId);
        if (upload) upload.aborted = true;
      },
    })),
    delete: vi.fn(async (key: string) => {
      bucketDeleted.push(key);
    }),
    // 組み上がる前の multipart はオブジェクトを持たない。掃除がそれを
    // 「もう何も無い」と読むかどうかが、この一覧の分かれ目になる。
    head: vi.fn(async (key: string) => bucketObjects.get(key) ?? null),
  };
});
const bucketDeleted: string[] = [];
const bucketObjects = new Map<string, { key: string }>();

import {
  cancelUpload,
  finishUpload,
  partCountOf,
  startUpload,
} from "../../apps/web/src/lib/storage-upload-server";
import { uploadPart } from "../../apps/web/src/lib/storage-upload-server";
import { abandonStaleStorageUploads } from "../../packages/api/src/storage-uploads";

const USER_ID = "user-storage";

function streamOf(size: number): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(size));
      controller.close();
    },
  });
}

describe("uploading a file too large for one request", () => {
  let state: ReturnType<typeof createInMemoryPrisma>["state"];

  beforeEach(() => {
    vi.clearAllMocks();
    bucket.uploads.clear();
    bucketDeleted.length = 0;
    const memory = createInMemoryPrisma();
    state = memory.state;
    setDbProvider(async () => memory.prisma as never);
    setR2BucketProvider(() => bucket as never);
  });

  it("cuts a file into parts the platform will carry", () => {
    // Every part but the last is the same size, which is what the bucket
    // requires, and none of them is anywhere near the 100 MB a request stops at.
    expect(STORAGE_UPLOAD_PART_BYTES).toBeLessThan(100 * 1024 * 1024);
    expect(partCountOf(BigInt(STORAGE_UPLOAD_PART_BYTES))).toBe(1);
    expect(partCountOf(BigInt(STORAGE_UPLOAD_PART_BYTES + 1))).toBe(2);
    expect(partCountOf(BigInt(STORAGE_QUOTA_BYTES))).toBe(
      Math.ceil(STORAGE_QUOTA_BYTES / STORAGE_UPLOAD_PART_BYTES),
    );
  });

  it("refuses a part longer than the size the upload was admitted for", async () => {
    // Otherwise an upload declaring nothing still holds parts of any length in
    // the bucket for a day, and none of it was counted against the quota.
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "empty.bin",
      mimeType: "application/octet-stream",
      size: BigInt(0),
    });
    if (!started.ok) throw new Error(started.reason);

    const outcome = await uploadPart({
      userId: USER_ID,
      uploadId: started.upload.id,
      partNumber: 1,
      contentLength: 8 * 1024 * 1024,
      body: streamOf(8 * 1024 * 1024),
    });

    expect(outcome).toEqual({
      ok: false,
      reason: "insufficientStorageSpace",
    });
  });

  it("takes a file in parts and stores it as one", async () => {
    const size = STORAGE_UPLOAD_PART_BYTES + 1_000;
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: BigInt(size),
    });
    if (!started.ok) throw new Error(started.reason);
    expect(started.upload.partCount).toBe(2);

    const first = await uploadPart({
      userId: USER_ID,
      uploadId: started.upload.id,
      partNumber: 1,
      contentLength: STORAGE_UPLOAD_PART_BYTES,
      body: streamOf(STORAGE_UPLOAD_PART_BYTES),
    });
    const second = await uploadPart({
      userId: USER_ID,
      uploadId: started.upload.id,
      partNumber: 2,
      contentLength: 1_000,
      body: streamOf(1_000),
    });
    if (!first.ok || !second.ok) throw new Error("a part was refused");

    const finished = await finishUpload({
      userId: USER_ID,
      uploadId: started.upload.id,
      parts: [
        { partNumber: 1, etag: first.etag },
        { partNumber: 2, etag: second.etag },
      ],
    });

    expect(finished).toMatchObject({ ok: true });
    if (!finished.ok) return;
    // The file is one object, sized by what actually arrived.
    expect(finished.file.size).toBe(BigInt(size));
    expect(state.files.size).toBe(1);
    // The row stays as the receipt of a finished upload, pointing at what it
    // made. Nothing is under way any more, and the sweep clears the receipt.
    const receipt = [...state.storageUploads.values()][0];
    expect(receipt?.completedFileId).toBe(finished.file.id);

    // Only the answer went missing: asking again gives the same file rather
    // than storing the same bytes a second time.
    const again = await finishUpload({
      userId: USER_ID,
      uploadId: started.upload.id,
      parts: [
        { partNumber: 1, etag: first.etag },
        { partNumber: 2, etag: second.etag },
      ],
    });
    expect(again).toMatchObject({ ok: true });
    if (!again.ok) return;
    expect(again.file.id).toBe(finished.file.id);
    expect(state.files.size).toBe(1);
  });

  it("refuses a part for an upload that is not the caller's", async () => {
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: BigInt(1_000),
    });
    if (!started.ok) throw new Error(started.reason);

    // Knowing an upload id is not the same as owning it, and the bucket would
    // take the part from anyone.
    const outcome = await uploadPart({
      userId: "someone-else",
      uploadId: started.upload.id,
      partNumber: 1,
      contentLength: 10,
      body: streamOf(10),
    });

    expect(outcome).toEqual({ ok: false, reason: "uploadNotFound" });
  });

  it("counts what is already on its way against the quota", async () => {
    const half = BigInt(STORAGE_QUOTA_BYTES) / BigInt(2);
    const first = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "one.bin",
      mimeType: "application/octet-stream",
      size: half + BigInt(1),
    });
    expect(first.ok).toBe(true);

    // Two uploads started at once would each see only what is stored, and
    // together they would pass the quota.
    const second = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "two.bin",
      mimeType: "application/octet-stream",
      size: half + BigInt(1),
    });

    expect(second).toEqual({ ok: false, reason: "insufficientStorageSpace" });
  });

  it("throws away what it cannot join", async () => {
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: BigInt(STORAGE_UPLOAD_PART_BYTES + 10),
    });
    if (!started.ok) throw new Error(started.reason);
    await uploadPart({
      userId: USER_ID,
      uploadId: started.upload.id,
      partNumber: 1,
      contentLength: STORAGE_UPLOAD_PART_BYTES,
      body: streamOf(STORAGE_UPLOAD_PART_BYTES),
    });

    // The second part never arrived, so there is no file to make — and the
    // parts that did arrive must not be left behind.
    const finished = await finishUpload({
      userId: USER_ID,
      uploadId: started.upload.id,
      parts: [
        { partNumber: 1, etag: "etag-1" },
        { partNumber: 2, etag: "etag-2" },
      ],
    });

    expect(finished).toEqual({ ok: false, reason: "uploadFailed" });
    expect(state.files.size).toBe(0);
    expect(state.storageUploads.size).toBe(0);
    expect([...bucket.uploads.values()].every((upload) => upload.aborted)).toBe(true);
  });

  it("gives up an upload the browser abandoned", async () => {
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: BigInt(1_000),
    });
    if (!started.ok) throw new Error(started.reason);

    expect(await cancelUpload({ userId: USER_ID, uploadId: started.upload.id }))
      .toBe("cancelled");
    expect(state.storageUploads.size).toBe(0);
    expect([...bucket.uploads.values()].every((upload) => upload.aborted)).toBe(true);
  });

  it("sweeps up what was left behind a day later", async () => {
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: BigInt(1_000),
    });
    if (!started.ok) throw new Error(started.reason);
    // An unfinished upload holds its parts, and their storage, until something
    // abandons it.
    const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000);

    const swept = await abandonStaleStorageUploads(tomorrow);

    expect(swept).toEqual({ abandoned: 1, failed: 0 });
    expect(state.storageUploads.size).toBe(0);
    expect([...bucket.uploads.values()].every((upload) => upload.aborted)).toBe(true);
  });

  it("keeps the row when an abort fails and nothing was there to clear", async () => {
    // 中止に失敗する理由は「もう組み上がっている」だけではない。パートのままの
    // multipart はオブジェクトを持たないので、一時の不調で失敗しただけのときも
    // 「何も無い」と同じ顔をする——そこで行を消すと、中止に必要な uploadId ごと
    // 失われ、パートは誰にも消せないまま残る。
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: BigInt(1_000),
    });
    if (!started.ok) throw new Error(started.reason);
    bucket.resumeMultipartUpload.mockImplementationOnce(() => ({
      uploadPart: async () => ({ partNumber: 1, etag: "etag-1" }),
      complete: async () => ({ size: 0 }),
      abort: async () => {
        throw new Error("the bucket is unreachable");
      },
    }));

    const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const swept = await abandonStaleStorageUploads(tomorrow);

    expect(swept).toEqual({ abandoned: 0, failed: 1 });
    expect(state.storageUploads.size).toBe(1);
  });

  it("leaves the object of an upload that finished while the sweep ran", async () => {
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: BigInt(1_000),
    });
    if (!started.ok) throw new Error(started.reason);
    const [tracked] = [...state.storageUploads.values()];
    // 一覧を引いたあと、順番が回ってくるまでに完了した。行はもう控えなので、
    // そのオブジェクトは File のもの——捨てるものは何も残っていない。
    state.storageUploads.set(tracked!.id, {
      ...tracked!,
      completedFileId: "file-1",
    });
    const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000);

    const swept = await abandonStaleStorageUploads(tomorrow);

    expect(swept).toEqual({ abandoned: 1, failed: 0 });
    expect(state.storageUploads.size).toBe(0);
    expect(bucketDeleted).toHaveLength(0);
    expect([...bucket.uploads.values()].every((upload) => !upload.aborted))
      .toBe(true);
  });

  it("cannot be finished once the sweep has claimed it", async () => {
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: BigInt(4),
    });
    if (!started.ok) throw new Error(started.reason);
    await uploadPart({
      userId: USER_ID,
      uploadId: started.upload.id,
      partNumber: 1,
      contentLength: 4,
      body: streamOf(4),
    });
    const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000);
    await abandonStaleStorageUploads(tomorrow);

    // 掃除が終えたあとに完了要求が届いても、そのパートはもう無い。ここで File を
    // 作ると、消えたオブジェクトを指すことになる。
    const outcome = await finishUpload({
      userId: USER_ID,
      uploadId: started.upload.id,
      parts: [{ partNumber: 1, etag: "etag-1" }],
    });

    expect(outcome).toEqual({ ok: false, reason: "uploadNotFound" });
    expect(state.files.size).toBe(0);
  });

  it("tries the abort again when a cancel finds the row already claimed", async () => {
    // 前の取り消しがここまで来て中止に失敗していると、行は掃除のものになって
    // いる。そこで「もう済んでいる」と答えると、パートはバケットに残ったまま
    // 一日ぶんの枠を抱える。
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: BigInt(1_000),
    });
    if (!started.ok) throw new Error(started.reason);
    const [tracked] = [...state.storageUploads.values()];
    state.storageUploads.set(tracked!.id, {
      ...tracked!,
      abandonedAt: new Date(),
    });

    expect(await cancelUpload({ userId: USER_ID, uploadId: started.upload.id }))
      .toBe("cancelled");

    expect([...bucket.uploads.values()].every((upload) => upload.aborted))
      .toBe(true);
    expect(state.storageUploads.size).toBe(0);
  });

  it("says the parts are still there when the bucket will not let go", async () => {
    // 片付いたと答えると、送った側はそこで手を引き、その分の枠が一日残る。
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: BigInt(1_000),
    });
    if (!started.ok) throw new Error(started.reason);
    bucket.resumeMultipartUpload.mockImplementationOnce(() => ({
      uploadPart: async () => ({ partNumber: 1, etag: "etag-1" }),
      complete: async () => ({ size: 0 }),
      abort: async () => {
        throw new Error("the bucket is unreachable");
      },
    }));

    expect(await cancelUpload({ userId: USER_ID, uploadId: started.upload.id }))
      .toBe("pending");
    // 行は残る。掃除がもう一度試せる唯一の手掛かりなので。
    expect(state.storageUploads.size).toBe(1);
  });

  it("sweeps a claimed upload without waiting out the day", async () => {
    // 掃除のものになった行は、誰かが既に「捨てる」と決めて捨てられなかったもの。
    // 手つかずのアップロードと同じ一日を待たせると、そのぶんの保管料と枠が理由
    // なく残る。
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: BigInt(1_000),
    });
    if (!started.ok) throw new Error(started.reason);
    const [tracked] = [...state.storageUploads.values()];
    state.storageUploads.set(tracked!.id, {
      ...tracked!,
      abandonedAt: new Date(),
    });

    const swept = await abandonStaleStorageUploads(new Date());

    expect(swept).toEqual({ abandoned: 1, failed: 0 });
    expect(state.storageUploads.size).toBe(0);
  });

  it("records a cancellation for an upload that has not appeared yet", async () => {
    // 開始の応答が返らなかった側が取り消しに回ってくる。まだ行が現れていない
    // だけかもしれないので、先回りして墓標を置く——そのあとに始めようとしたもの
    // は、この行にぶつかって始まらない。
    const id = crypto.randomUUID();

    expect(await cancelUpload({ userId: USER_ID, uploadId: id }))
      .toBe("cancelled");

    const refused = await startUpload({
      userId: USER_ID,
      id,
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: BigInt(1_000),
    });

    expect(refused).toEqual({ ok: false, reason: "uploadFailed" });
    // すぐには消さない。遅れて現れる開始を止めるために置いたものなので、その
    // 開始より先に消えては意味がない。
    expect(await abandonStaleStorageUploads(new Date()))
      .toEqual({ abandoned: 0, failed: 0 });
    expect(state.storageUploads.size).toBe(1);

    const later = new Date(Date.now() + 16 * 60 * 1000);
    expect(await abandonStaleStorageUploads(later))
      .toEqual({ abandoned: 1, failed: 0 });
    expect(state.storageUploads.size).toBe(0);
  });

  it("stops placing marks for uploads that never appear", async () => {
    // 墓標はどんな名前にも置けるので、数だけが際限なく増える。抱えているものが
    // 無いぶん枠にも本数にも数えられないから、ここで限る。
    for (let index = 0; index < 20; index++) {
      await cancelUpload({ userId: USER_ID, uploadId: crypto.randomUUID() });
    }

    expect(state.storageUploads.size).toBe(16);
    expect(await cancelUpload({ userId: USER_ID, uploadId: crypto.randomUUID() }))
      .toBe("missing");
  });

  it("stops placing marks even when the cancellations arrive together", async () => {
    // 数えるのと書くのが別々だと、同時に届いた取り消しがどれも「まだ上限より下」
    // を読み、いくらでも置けてしまう。一続きにしてあれば、同時に来ても上限で
    // 止まる。
    await Promise.all(
      Array.from({ length: 32 }, () =>
        cancelUpload({ userId: USER_ID, uploadId: crypto.randomUUID() })),
    );

    expect(state.storageUploads.size).toBe(16);
  });

  it("keeps the size of a claimed upload against the quota", async () => {
    // 掃除が「捨てる」と宣言しても、中止に失敗しているあいだ、そのパートは
    // 本当にバケットにある。枠から外すと、実際の使用量が枠の外に出る。
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: BigInt(STORAGE_QUOTA_BYTES),
    });
    if (!started.ok) throw new Error(started.reason);
    const [tracked] = [...state.storageUploads.values()];
    state.storageUploads.set(tracked!.id, {
      ...tracked!,
      abandonedAt: new Date(),
    });

    const next = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "another.mp4",
      mimeType: "video/mp4",
      size: BigInt(1_000),
    });

    expect(next).toEqual({ ok: false, reason: "insufficientStorageSpace" });
  });

  it("records a multipart nothing points at when it cannot be abandoned", async () => {
    // 行の無いマルチパートは、どこからも辿れないままパートを抱え続ける。捨て
    // られなかったのなら、せめて掃除が見つけられる場所に書き留める。
    const first = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: BigInt(STORAGE_QUOTA_BYTES),
    });
    if (!first.ok) throw new Error(first.reason);
    bucket.resumeMultipartUpload.mockImplementationOnce(() => ({
      uploadPart: async () => ({ partNumber: 1, etag: "etag-1" }),
      complete: async () => ({ size: 0 }),
      abort: async () => {
        throw new Error("the bucket is unreachable");
      },
    }));

    const refused = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "another.mp4",
      mimeType: "video/mp4",
      size: BigInt(1_000),
    });

    expect(refused).toEqual({ ok: false, reason: "insufficientStorageSpace" });
    // 断られたぶんの追跡行が、掃除のものとして残っている。
    const abandoned = [...state.storageUploads.values()].filter(
      (item) => item.abandonedAt !== null,
    );
    expect(abandoned).toHaveLength(1);
  });

  it("refuses to start once the account holds as many files as it may", async () => {
    // 容量だけでは本数を縛れない。1 バイトのファイルを順に完成させれば、枠の
    // 内側で R2 のオブジェクトと行をいくらでも増やせる。
    for (let index = 0; index < STORAGE_FILE_COUNT_LIMIT; index++) {
      state.files.set(`file-${index}`, {
        id: `file-${index}`,
        objectKey: `key-${index}`,
        name: `file-${index}.bin`,
        size: 1,
        mimeType: "application/octet-stream",
        userId: USER_ID,
        visibility: "PRIVATE",
        sha256: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never);
    }

    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: BigInt(4),
    });

    expect(started).toEqual({ ok: false, reason: "tooManyFiles" });
    // 誰も知らないマルチパートを残さない。
    expect([...bucket.uploads.values()].every((upload) => upload.aborted))
      .toBe(true);
    expect(state.storageUploads.size).toBe(0);
  });

  it("leaves an upload that has only just started alone", async () => {
    await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: BigInt(1_000),
    });

    expect(await abandonStaleStorageUploads(new Date())).toEqual({
      abandoned: 0,
      failed: 0,
    });
    expect(state.storageUploads.size).toBe(1);
  });
});
