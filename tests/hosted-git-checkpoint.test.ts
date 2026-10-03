import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CheckpointSha256 } from "../packages/api/src/git/checkpoint-sha256";

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

});
