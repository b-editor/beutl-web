import { describe, expect, it, vi } from "vitest";
import {
  locateStorageObject,
  moveStorageObject,
  moveStorageObjectsBatch,
  StorageMoveError,
  type MovableFile,
  type StorageProvider,
  type StorageStore,
} from "@beutl/api";

function bytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 7 + seed) & 0xff;
  return out;
}

async function drain(value: ArrayBuffer | ReadableStream | string): Promise<Uint8Array> {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(await new Response(value).arrayBuffer());
}

// An in-memory store shaped like the R2 binding, with hooks a test can break.
function memoryStore(provider: StorageProvider, objects: Record<string, Uint8Array> = {}) {
  const data = new Map<string, Uint8Array>(Object.entries(objects));
  const bucket = {
    put: vi.fn(async (key: string, value: ArrayBuffer | ReadableStream | string) => {
      data.set(key, await drain(value));
    }),
    get: vi.fn(async (key: string) => {
      const found = data.get(key);
      if (!found) return null;
      return {
        size: found.byteLength,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(found);
            controller.close();
          },
        }),
      };
    }),
    head: vi.fn(async (key: string) => {
      const found = data.get(key);
      return found ? { size: found.byteLength } : null;
    }),
    delete: vi.fn(async (key: string) => {
      data.delete(key);
    }),
  };
  const store: StorageStore = { provider, bucket, label: provider.toUpperCase() };
  return { store, bucket, data };
}

describe("moving one object between stores", () => {
  it("copies, verifies, then deletes the source", async () => {
    const payload = bytes(4096, 1);
    const r2 = memoryStore("r2", { key: payload });
    const s3 = memoryStore("s3");

    const outcome = await moveStorageObject({
      objectKey: "key",
      to: "s3",
      stores: [s3.store, r2.store],
      expectedSize: 4096,
      contentType: "video/mp4",
    });

    expect(outcome).toEqual({ kind: "moved", from: "r2", to: "s3", size: 4096, sourceRemoved: true });
    expect(s3.data.get("key")).toEqual(payload);
    expect(r2.data.has("key")).toBe(false);
    expect(s3.bucket.put).toHaveBeenCalledWith("key", expect.any(ReadableStream), {
      httpMetadata: { contentType: "video/mp4" },
      contentLength: 4096,
    });
    // The source is only removed after the copy was measured.
    expect(s3.bucket.head.mock.invocationCallOrder[1]).toBeLessThan(r2.bucket.delete.mock.invocationCallOrder[0]);
  });

  it("does nothing when the object is already in the destination", async () => {
    const s3 = memoryStore("s3", { key: bytes(8, 2) });
    const r2 = memoryStore("r2");
    expect(await moveStorageObject({ objectKey: "key", to: "s3", stores: [s3.store, r2.store], expectedSize: 8 }))
      .toEqual({ kind: "already-there", to: "s3", removedFrom: [] });
    expect(s3.bucket.put).not.toHaveBeenCalled();
  });

  it("removes the copy a failed earlier move left behind", async () => {
    const payload = bytes(8, 3);
    const s3 = memoryStore("s3", { key: payload });
    const r2 = memoryStore("r2", { key: payload });
    expect(await moveStorageObject({ objectKey: "key", to: "s3", stores: [s3.store, r2.store], expectedSize: 8 }))
      .toEqual({ kind: "already-there", to: "s3", removedFrom: ["r2"] });
    expect(r2.data.has("key")).toBe(false);
    expect(s3.data.get("key")).toEqual(payload);
  });

  it("keeps both copies when the destination copy has the wrong size", async () => {
    const s3 = memoryStore("s3", { key: bytes(4, 4) });
    const r2 = memoryStore("r2", { key: bytes(8, 4) });
    await expect(moveStorageObject({ objectKey: "key", to: "s3", stores: [s3.store, r2.store], expectedSize: 8 }))
      .rejects.toMatchObject({ name: "StorageMoveError", reason: "size-mismatch" });
    expect(r2.data.has("key")).toBe(true);
    expect(s3.data.has("key")).toBe(true);
  });

  it("treats an unmeasurable destination copy as unverified", async () => {
    const s3 = memoryStore("s3");
    const r2 = memoryStore("r2", { key: bytes(16, 9) });
    s3.bucket.head.mockResolvedValueOnce(null).mockResolvedValue({ size: undefined });
    await expect(moveStorageObject({ objectKey: "key", to: "s3", stores: [s3.store, r2.store], expectedSize: 16 }))
      .rejects.toMatchObject({ reason: "verification-failed" });
    expect(r2.data.has("key")).toBe(true);
  });

  it("does not remove a leftover when the destination copy cannot be measured", async () => {
    const s3 = memoryStore("s3", { key: bytes(8, 10) });
    const r2 = memoryStore("r2", { key: bytes(8, 10) });
    s3.bucket.head.mockResolvedValue({ size: undefined });
    await expect(moveStorageObject({ objectKey: "key", to: "s3", stores: [s3.store, r2.store], expectedSize: 8 }))
      .rejects.toMatchObject({ reason: "size-mismatch" });
    expect(r2.data.has("key")).toBe(true);
  });

  it("keeps the last copy when the destination vanished before the leftover was removed", async () => {
    const s3 = memoryStore("s3", { key: bytes(8, 11) });
    const r2 = memoryStore("r2", { key: bytes(8, 11) });
    s3.bucket.head.mockResolvedValueOnce({ size: 8 }).mockResolvedValueOnce(null);
    await expect(moveStorageObject({ objectKey: "key", to: "s3", stores: [s3.store, r2.store], expectedSize: 8 }))
      .rejects.toMatchObject({ reason: "verification-failed" });
    expect(r2.data.has("key")).toBe(true);
    expect(r2.bucket.delete).not.toHaveBeenCalled();
  });

  it("runs opposing moves of one object one after the other", async () => {
    const payload = bytes(8, 12);
    const s3 = memoryStore("s3", { key: payload });
    const r2 = memoryStore("r2", { key: payload });
    const stores = [s3.store, r2.store];
    const [toS3, toR2] = await Promise.all([
      moveStorageObject({ objectKey: "key", to: "s3", stores, expectedSize: 8 }),
      moveStorageObject({ objectKey: "key", to: "r2", stores, expectedSize: 8 }),
    ]);
    expect(toS3).toEqual({ kind: "already-there", to: "s3", removedFrom: ["r2"] });
    expect(toR2).toMatchObject({ kind: "moved", from: "s3", to: "r2", sourceRemoved: true });
    expect(r2.data.get("key")).toEqual(payload);
    expect(s3.data.has("key")).toBe(false);
  });

  it("refuses a source that changed size between HEAD and GET", async () => {
    const s3 = memoryStore("s3");
    const r2 = memoryStore("r2", { key: bytes(8, 13) });
    r2.bucket.get.mockImplementationOnce(async () => ({
      size: 9,
      body: new ReadableStream<Uint8Array>({ start: (c) => { c.enqueue(bytes(9, 13)); c.close(); } }),
    }));
    await expect(moveStorageObject({ objectKey: "key", to: "s3", stores: [s3.store, r2.store], expectedSize: 8 }))
      .rejects.toMatchObject({ reason: "size-mismatch" });
    expect(s3.bucket.put).not.toHaveBeenCalled();
    expect(r2.data.has("key")).toBe(true);
  });

  it("reports an object that no store holds", async () => {
    const s3 = memoryStore("s3");
    const r2 = memoryStore("r2");
    expect(await moveStorageObject({ objectKey: "key", to: "s3", stores: [s3.store, r2.store] }))
      .toEqual({ kind: "missing" });
  });

  it("refuses to copy a source that disagrees with the record", async () => {
    const s3 = memoryStore("s3");
    const r2 = memoryStore("r2", { key: bytes(10, 5) });
    await expect(moveStorageObject({ objectKey: "key", to: "s3", stores: [s3.store, r2.store], expectedSize: 11 }))
      .rejects.toMatchObject({ reason: "size-mismatch" });
    expect(s3.bucket.put).not.toHaveBeenCalled();
    expect(r2.data.has("key")).toBe(true);
  });

  it("discards a copy that does not read back whole and keeps the source", async () => {
    const s3 = memoryStore("s3");
    const r2 = memoryStore("r2", { key: bytes(16, 6) });
    // Absent before the copy, then read back one byte short.
    s3.bucket.head.mockResolvedValueOnce(null).mockResolvedValue({ size: 15 });
    await expect(moveStorageObject({ objectKey: "key", to: "s3", stores: [s3.store, r2.store], expectedSize: 16 }))
      .rejects.toMatchObject({ reason: "verification-failed" });
    expect(s3.bucket.delete).toHaveBeenCalledWith("key");
    expect(r2.data.has("key")).toBe(true);
  });

  it("reports a source that could not be deleted after a good copy", async () => {
    const s3 = memoryStore("s3");
    const r2 = memoryStore("r2", { key: bytes(16, 7) });
    r2.bucket.delete.mockRejectedValueOnce(new Error("r2 down"));
    const outcome = await moveStorageObject({ objectKey: "key", to: "s3", stores: [s3.store, r2.store], expectedSize: 16 });
    expect(outcome).toMatchObject({ kind: "moved", sourceRemoved: false });
    expect(s3.data.has("key")).toBe(true);
  });

  it("rejects a destination that is not configured", async () => {
    const r2 = memoryStore("r2");
    await expect(moveStorageObject({ objectKey: "key", to: "s3", stores: [r2.store] }))
      .rejects.toBeInstanceOf(StorageMoveError);
  });

  it("locates an object across stores in store order", async () => {
    const s3 = memoryStore("s3", { both: bytes(1, 8) });
    const r2 = memoryStore("r2", { both: bytes(1, 8), old: bytes(2, 8) });
    expect(await locateStorageObject("both", [s3.store, r2.store])).toEqual([
      { provider: "s3", size: 1 },
      { provider: "r2", size: 1 },
    ]);
    expect(await locateStorageObject("old", [s3.store, r2.store])).toEqual([{ provider: "r2", size: 2 }]);
    expect(await locateStorageObject("none", [s3.store, r2.store])).toEqual([]);
  });
});

describe("moving files in bulk", () => {
  function files(count: number): MovableFile[] {
    return Array.from({ length: count }, (_, index) => ({
      id: `file-${index}`,
      name: `file ${index}`,
      objectKey: `key-${index}`,
      size: 4,
      mimeType: "application/octet-stream",
      cursor: `c${index}`,
    }));
  }

  function pager(all: MovableFile[], pageSize: number) {
    return async (cursor: string | undefined) => {
      const start = cursor === undefined ? 0 : all.findIndex((file) => file.cursor === cursor) + 1;
      return all.slice(start, start + pageSize);
    };
  }

  it("moves what is not yet at the destination and skips what is", async () => {
    const all = files(5);
    const r2 = memoryStore("r2", { "key-0": bytes(4, 0), "key-2": bytes(4, 2), "key-4": bytes(4, 4) });
    const s3 = memoryStore("s3", { "key-1": bytes(4, 1) });
    const moved: string[] = [];

    const outcome = await moveStorageObjectsBatch({
      to: "s3",
      stores: [s3.store, r2.store],
      nextPage: pager(all, 2),
      cursor: undefined,
      limits: { moves: 10, scanned: 100, milliseconds: 60_000 },
      onObjectChanged: async (file) => {
        moved.push(file.id);
      },
    });

    expect(outcome).toEqual({
      scanned: 5,
      moved: 3,
      alreadyThere: 1,
      missing: 1,
      failed: [],
      nextCursor: undefined,
      done: true,
    });
    expect(moved).toEqual(["file-0", "file-2", "file-4"]);
    expect([...s3.data.keys()].sort()).toEqual(["key-0", "key-1", "key-2", "key-4"]);
    expect(r2.data.size).toBe(0);
  });

  it("reports a leftover copy it removed along the way", async () => {
    const all = files(1);
    const r2 = memoryStore("r2", { "key-0": bytes(4, 0) });
    const s3 = memoryStore("s3", { "key-0": bytes(4, 0) });
    const changed: string[] = [];
    const outcome = await moveStorageObjectsBatch({
      to: "s3",
      stores: [s3.store, r2.store],
      nextPage: pager(all, 10),
      cursor: undefined,
      limits: { moves: 10, scanned: 100, milliseconds: 60_000 },
      onObjectChanged: async (file, result) => {
        changed.push(`${file.id}:${result.kind}`);
      },
    });
    expect(outcome).toMatchObject({ moved: 0, alreadyThere: 1, done: true });
    expect(changed).toEqual(["file-0:already-there"]);
    expect(r2.data.size).toBe(0);
  });

  it("stops at the move limit and hands back where to resume", async () => {
    const all = files(6);
    const r2 = memoryStore("r2", Object.fromEntries(all.map((file, index) => [file.objectKey, bytes(4, index)])));
    const s3 = memoryStore("s3");
    const pages = vi.fn(pager(all, 2));

    const first = await moveStorageObjectsBatch({
      to: "s3",
      stores: [s3.store, r2.store],
      nextPage: pages,
      cursor: undefined,
      limits: { moves: 2, scanned: 100, milliseconds: 60_000 },
    });
    expect(first).toMatchObject({ moved: 2, scanned: 2, nextCursor: "c1", done: false });
    // The limit was reached on the last file of a page; no further page is read.
    expect(pages).toHaveBeenCalledTimes(1);

    const second = await moveStorageObjectsBatch({
      to: "s3",
      stores: [s3.store, r2.store],
      nextPage: pager(all, 4),
      cursor: first.nextCursor,
      limits: { moves: 10, scanned: 100, milliseconds: 60_000 },
    });
    expect(second).toMatchObject({ moved: 4, scanned: 4, nextCursor: undefined, done: true });
    expect(s3.data.size).toBe(6);
  });

  it("stops when the time budget is spent", async () => {
    const all = files(3);
    const r2 = memoryStore("r2", Object.fromEntries(all.map((file, index) => [file.objectKey, bytes(4, index)])));
    const s3 = memoryStore("s3");
    let clock = 0;
    const outcome = await moveStorageObjectsBatch({
      to: "s3",
      stores: [s3.store, r2.store],
      nextPage: pager(all, 10),
      cursor: undefined,
      limits: { moves: 10, scanned: 100, milliseconds: 5 },
      now: () => (clock += 2),
    });
    expect(outcome.done).toBe(false);
    expect(outcome).toMatchObject({ scanned: 1, moved: 1, nextCursor: "c0" });
  });

  it("records a failure and carries on with the next file", async () => {
    const all = files(2);
    const r2 = memoryStore("r2", { "key-0": bytes(9, 0), "key-1": bytes(4, 1) });
    const s3 = memoryStore("s3");
    const outcome = await moveStorageObjectsBatch({
      to: "s3",
      stores: [s3.store, r2.store],
      nextPage: pager(all, 10),
      cursor: undefined,
      limits: { moves: 10, scanned: 100, milliseconds: 60_000 },
    });
    expect(outcome.failed).toEqual([
      { id: "file-0", name: "file 0", error: expect.stringContaining("not the recorded 4") },
    ]);
    expect(outcome.moved).toBe(1);
    expect(outcome.done).toBe(true);
  });
});
