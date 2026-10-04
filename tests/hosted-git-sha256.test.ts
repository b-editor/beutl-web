import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ResumableSha256 } from "../packages/api/src/git/resumable-sha256";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("resumable SHA-256", () => {
  it("matches standard SHA-256 at padding and block boundaries", () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 1024]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 31 + 17) % 256);
      const hash = new ResumableSha256();
      for (let i = 0; i < bytes.length; i += 7) hash.update(bytes.subarray(i, i + 7));
      expect(hash.digestHex(), `length ${length}`).toBe(sha256(bytes));
    }
  });

  it("resumes from a state saved at any offset, as separate PATCH requests do", () => {
    const bytes = Uint8Array.from({ length: 200_003 }, (_, i) => i * 73 % 251);
    for (const cuts of [[32_768], [1, 63, 64, 65], [5_000_001 % 200_003, 100_000, 199_999]]) {
      let state; let offset = 0;
      for (const cut of [...cuts.sort((a, b) => a - b), bytes.length]) {
        const hash = new ResumableSha256(state, offset);
        hash.update(bytes.subarray(offset, cut));
        // A JSON round trip is what the repository object stores between requests.
        state = JSON.parse(JSON.stringify(hash.snapshot()));
        offset = cut;
      }
      expect(new ResumableSha256(state, offset).digestHex(), `cuts ${cuts}`).toBe(sha256(bytes));
    }
  });

  it("rejects a state that does not describe the claimed length", () => {
    const hash = new ResumableSha256();
    hash.update(new Uint8Array(70));
    const state = hash.snapshot();
    expect(atob(state.tail)).toHaveLength(6);
    expect(() => new ResumableSha256(state, 71)).toThrow("Invalid SHA-256 state");
    expect(() => new ResumableSha256({ ...state, tail: "!" }, 70)).toThrow("Invalid SHA-256 state");
    expect(() => new ResumableSha256({ ...state, words: state.words.slice(1) }, 70)).toThrow("Invalid SHA-256 state");
    expect(() => new ResumableSha256({ words: state.words, tail: btoa("x".repeat(64)) }, 128)).toThrow("Invalid SHA-256 state");
    expect(() => new ResumableSha256(undefined, 64)).toThrow("Invalid SHA-256 state");
  });

  it("hashes a 32 MiB part quickly enough for one Worker request", () => {
    const bytes = Uint8Array.from({ length: 32 * 1024 ** 2 }, (_, i) => i * 7);
    const hash = new ResumableSha256();
    const started = performance.now();
    for (let i = 0; i < bytes.length; i += 64 * 1024 + 3) hash.update(bytes.subarray(i, i + 64 * 1024 + 3));
    const digest = hash.digestHex();
    const elapsed = performance.now() - started;
    expect(digest).toBe(sha256(bytes));
    expect(elapsed).toBeLessThan(5_000);
  });
});
