import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CheckpointSha256 } from "../packages/api/src/git/checkpoint-sha256";
import { advanceCompletedVerification } from "../packages/api/src/git/multipart";
import type { GitObjectBucket } from "../packages/api/src/git/git-object-store";
import type { GitDurableStorage } from "../packages/api/src/git/lfs";

class Storage implements GitDurableStorage {
  values = new Map<string, unknown>();
  async get<T>(key: string) { return this.values.get(key) as T | undefined; }
  async put<T>(key: string, value: T) { this.values.set(key, value); }
  async delete(key: string) { return this.values.delete(key); }
  async list<T>({ prefix }: { prefix: string }) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix))) as Map<string, T>;
  }
  async setAlarm(_time: number) { }
}

describe("version-pinned resumable SHA-256", () => {
  it("matches standard SHA-256 at padding and block boundaries", () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 1024]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 31 + 17) % 256);
      const hash = new CheckpointSha256();
      for (let i = 0; i < bytes.length; i += 7) hash.update(bytes.subarray(i, i + 7));
      expect(hash.digestHex(), `length ${length}`).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });

  it("restores SHA-256 chaining words at block boundaries", () => {
    const bytes = Uint8Array.from({ length: 65_537 }, (_, i) => i * 73 % 251);
    const hash = new CheckpointSha256();
    hash.update(bytes.subarray(0, 32_768));
    const checkpoint = hash.snapshot();
    const resumed = new CheckpointSha256(checkpoint.words, checkpoint.offset);
    for (let i = 32_768; i < bytes.length; i += 113) resumed.update(bytes.subarray(i, i + 113));
    expect(resumed.digestHex()).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(() => new CheckpointSha256(checkpoint.words, 1)).toThrow();
  });

  it("resumes the exact B2 version after a lost response, without trusting another version", async () => {
    const bytes = Uint8Array.from({ length: 2_111 }, (_, i) => i * 19 % 257);
    const oid = createHash("sha256").update(bytes).digest("hex");
    const storage = new Storage();
    const ranges: number[] = [];
    let interrupted = false;
    const bucket = {
      async head(_key: string, versionId?: string) {
        return { size: bytes.length, versionId: versionId ?? "v1" };
      },
      async getRange(_key: string, versionId: string, start: number, length: number) {
        ranges.push(start);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            if (start === 1_024 && !interrupted) {
              interrupted = true;
              controller.enqueue(bytes.subarray(start, start + 10));
              controller.error(new Error("connection lost"));
            } else {
              controller.enqueue(bytes.subarray(start, start + length));
              controller.close();
            }
          },
        });
        return { size: bytes.length, versionId, body };
      },
    } as GitObjectBucket;
    const verify = (versionId = "v1") => advanceCompletedVerification(
      bucket, storage, "repo", oid, bytes.length, versionId, new AbortController().signal, 1_024);
    expect(await verify()).toBe("pending");
    await expect(verify()).rejects.toThrow("connection lost");
    expect((await storage.get<{ offset: number }>(`sha256:${oid}`))?.offset).toBe(1_024);
    expect(await verify("v2")).toBe("pending");
    expect((await storage.get<{ versionId: string }>(`sha256:${oid}`))?.versionId).toBe("v2");
    expect(await verify()).toBe("pending");
    expect(await verify()).toBe("pending");
    expect(await verify()).toBe("verified");
    expect(ranges).toEqual([0, 1_024, 0, 0, 1_024, 2_048]);
    expect(await storage.get(`sha256:${oid}`)).toBeUndefined();
  });
});
