import { describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { GitRepositoryDurableObject } from "../packages/api/src/git/repo-durable-object";

const execute = promisify(execFile);
const repoId = "12345678-1234-1234-1234-123456789abc";
const objectsPrefix = `git/repos/${repoId}/repo.git/objects/`;

class Bucket {
  objects = new Map<string, Uint8Array>();
  reads: string[] = [];
  failReads?: (key: string) => boolean;
  async get(key: string) {
    this.reads.push(key);
    if (this.failReads?.(key)) throw new Error("B2 read failed");
    const bytes = this.objects.get(key); if (!bytes) return null;
    return { size: bytes.length, body: new Response(bytes).body!, arrayBuffer: async () => bytes.slice().buffer };
  }
  async put(key: string, bytes: Uint8Array) { this.objects.set(key, Uint8Array.from(bytes)); }
  async head(key: string) { const bytes = this.objects.get(key); return bytes ? { size: bytes.length } : null; }
  async delete(key: string | string[]) { for (const k of Array.isArray(key) ? key : [key]) this.objects.delete(k); }
  async list({ prefix, delimiter }: { prefix: string; delimiter?: string }) {
    const objects = [], prefixes = new Set<string>();
    for (const [key, bytes] of this.objects) if (key.startsWith(prefix)) {
      const index = delimiter ? key.slice(prefix.length).indexOf(delimiter) : -1;
      if (index >= 0) prefixes.add(key.slice(0, prefix.length + index + delimiter!.length));
      else objects.push({ key, size: bytes.length });
    }
    return { objects, delimitedPrefixes: [...prefixes], truncated: false };
  }
  /** Every object ID the stored pack indexes name. */
  packedOids(): string[] {
    const oids: string[] = [];
    for (const [key, index] of this.objects) if (key.startsWith(objectsPrefix) && key.endsWith(".idx")) {
      const count = new DataView(index.buffer, index.byteOffset).getUint32(8 + 255 * 4);
      for (let i = 0; i < count; i++) oids.push(Buffer.from(index.subarray(1032 + i * 20, 1052 + i * 20)).toString("hex"));
    }
    return oids;
  }
  packKeys() { return [...this.objects.keys()].filter((key) => key.startsWith(`${objectsPrefix}pack/`)).sort(); }
  historyBytes() {
    return [...this.objects].filter(([key]) => key.startsWith(objectsPrefix)).reduce((sum, [, bytes]) => sum + bytes.length, 0);
  }
}
class Storage {
  values = new Map<string, any>(); alarm: number | null = null;
  async get<T>(key: string) { return structuredClone(this.values.get(key)) as T | undefined; }
  async put<T>(key: string, value: T) { this.values.set(key, structuredClone(value)); }
  async delete(key: string | string[]) { for (const k of Array.isArray(key) ? key : [key]) this.values.delete(k); }
  async list<T>({ prefix, startAfter, limit = Infinity }: { prefix: string; startAfter?: string; limit?: number }) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter))
      .sort(([a], [b]) => a.localeCompare(b)).slice(0, limit)) as Map<string, T>;
  }
  async getAlarm() { return this.alarm; }
  async setAlarm(time: number) { this.alarm = time; }
}

/** A repository object served to native Git, with config isolated from the developer's. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "beutl-git-history-"));
  const storage = new Storage(), bucket = new Bucket();
  const accounting = { reserveHistory: vi.fn(async () => true), settleHistory: vi.fn(async () => undefined),
    reserveLfs: vi.fn(async () => "reserved"), commitLfs: vi.fn(async () => undefined), extendLfs: vi.fn(async () => undefined),
    releaseLfs: vi.fn(async () => undefined), releaseRepository: vi.fn(async () => undefined) };
  const durable = new GitRepositoryDurableObject({ storage }, {}, bucket as never, accounting as never);
  const server = createServer(async (incoming, outgoing) => {
    try {
      const headers = new Headers({ "x-beutl-repo-id": repoId, "x-beutl-git-scope": "write", "x-beutl-git-owner-id": "owner" });
      for (const [key, value] of Object.entries(incoming.headers)) if (typeof value === "string") headers.set(key, value);
      const result = await durable.fetch(new Request(`http://127.0.0.1${incoming.url}`, {
        method: incoming.method, headers, ...(incoming.method === "POST" ? { body: Readable.toWeb(incoming), duplex: "half" } : {}),
      } as RequestInit));
      outgoing.writeHead(result.status, Object.fromEntries(result.headers));
      outgoing.end(new Uint8Array(await result.arrayBuffer()));
    } catch (error) { outgoing.writeHead(500); outgoing.end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v3/git/${repoId}.git`;
  const home = join(root, "home"); mkdirSync(home);
  const env = { PATH: process.env.PATH!, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
  const work = join(root, "work"); mkdirSync(work);
  const git = async (...args: string[]) => (await execute("git", args, { cwd: work, env, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
  const commit = async (files: Record<string, string | Uint8Array>, message: string) => {
    for (const [name, content] of Object.entries(files)) { writeFileSync(join(work, name), content); await git("add", name); }
    await git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  await git("init", "-q", "-b", "main");
  await git("remote", "add", "origin", url);
  /** Clones the repository afresh and checks every object it received. */
  const clone = async () => {
    const copy = join(root, `clone-${randomBytes(4).toString("hex")}`);
    await execute("git", ["clone", "-q", url, copy], { env });
    await execute("git", ["fsck", "--no-progress", "--strict"], { cwd: copy, env });
    return copy;
  };
  const collect = () => durable.alarm();
  const close = async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (!root.startsWith(tmpdir() + sep)) throw new Error("Git fixture escaped the temporary directory");
    rmSync(root, { recursive: true, force: true });
  };
  return { storage, bucket, accounting, git, commit, clone, collect, close };
}

/** Text that compresses poorly but deltas well against a near copy. */
const lines = (seed: string, count: number) => Array.from({ length: count }, (_, n) => `${seed}-${n}-${randomBytes(24).toString("hex")}\n`).join("");

describe("unreachable Git history collection", () => {
  it("removes a deleted branch's objects and keeps what a clone needs", async () => {
    const f = await fixture();
    try {
      await f.commit({ "project.txt": "first\n" }, "first");
      await f.git("push", "-q", "origin", "main");
      await f.git("switch", "-q", "-c", "feature");
      await f.commit({ "draft.bin": randomBytes(256 * 1024) }, "draft");
      const draft = await f.git("rev-parse", "HEAD:draft.bin");
      const feature = await f.git("rev-parse", "HEAD");
      await f.git("push", "-q", "origin", "feature");
      await f.git("switch", "-q", "main");
      await f.commit({ "project.txt": "second\n" }, "second");
      await f.git("push", "-q", "origin", "main", ":feature");
      const before = f.bucket.historyBytes();
      expect(f.bucket.packedOids()).toEqual(expect.arrayContaining([draft, feature]));

      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      await f.collect();
      expect(info).toHaveBeenCalledWith("Git history collected", expect.objectContaining({ repoId, objects: 3 }));
      info.mockRestore();
      expect(f.bucket.packedOids()).not.toContain(draft);
      expect(f.bucket.packedOids()).not.toContain(feature);
      // Every pushed pack became one.
      expect(f.bucket.packKeys()).toHaveLength(2);
      expect(f.bucket.historyBytes()).toBeLessThan(before - 256 * 1024);
      expect(f.accounting.settleHistory).toHaveBeenLastCalledWith(repoId, expect.any(Number));
      expect(await f.storage.get("gitGcPending")).toBeUndefined();
      const copy = await f.clone();
      expect(readFileSync(join(copy, "project.txt"), "utf8")).toBe("second\n");

      // Without another push the history is not walked again.
      f.bucket.reads = [];
      await f.collect();
      expect(f.bucket.reads.filter((key) => key.startsWith("git/"))).toEqual([]);

      // Pushes after a collection build on the collected pack.
      await f.commit({ "project.txt": "third\n" }, "third");
      await f.git("push", "-q", "origin", "main");
      await f.collect();
      expect(readFileSync(join(await f.clone(), "project.txt"), "utf8")).toBe("third\n");
    } finally { await f.close(); }
  }, 60_000);

  it("keeps the base of a stored delta after a force push drops the history that held it", async () => {
    const f = await fixture();
    try {
      const draft = lines("draft", 2000);
      await f.commit({ "project.txt": draft }, "draft");
      const draftBlob = await f.git("rev-parse", "HEAD:project.txt");
      await f.git("push", "-q", "origin", "main");
      // Git sends the final text as a delta against the draft the server holds.
      const final = `${draft}final\n`;
      await f.commit({ "project.txt": final }, "final");
      const finalCommit = await f.git("rev-parse", "HEAD");
      await f.git("push", "-q", "origin", "main");
      // The rewritten history keeps the final text, which the server already
      // has, but no longer reaches the draft its stored delta names.
      await f.git("switch", "-q", "--orphan", "rewrite");
      await f.commit({ "project.txt": final }, "rewritten");
      await f.git("push", "-q", "-f", "origin", "rewrite:main");
      const before = f.bucket.historyBytes();

      await f.collect();
      const stored = f.bucket.packedOids();
      expect(stored).not.toContain(finalCommit);
      expect(stored).toContain(draftBlob);
      // The delta stayed compressed: the text was stored once, not twice.
      expect(f.bucket.historyBytes()).toBeLessThan(before);
      const copy = await f.clone();
      expect(readFileSync(join(copy, "project.txt"), "utf8")).toBe(final);
    } finally { await f.close(); }
  }, 60_000);

  it("leaves the history alone when every stored object is reachable", async () => {
    const f = await fixture();
    try {
      await f.commit({ "project.txt": "first\n" }, "first");
      await f.git("push", "-q", "origin", "main");
      await f.commit({ "project.txt": "second\n" }, "second");
      await f.git("push", "-q", "origin", "main");
      const packs = f.bucket.packKeys();
      await f.collect();
      expect(f.bucket.packKeys()).toEqual(packs);
      expect(await f.storage.get<number>("historyCollectedAt")).toBe(await f.storage.get<number>("lastPushFinishedAt"));
    } finally { await f.close(); }
  }, 60_000);

  it("deletes a pack a push left unindexed even when every indexed object is reachable", async () => {
    const f = await fixture();
    try {
      await f.commit({ "project.txt": "first\n" }, "first");
      await f.git("push", "-q", "origin", "main");
      const packs = f.bucket.packKeys();
      await f.bucket.put(`${objectsPrefix}pack/recv-1.pack`, randomBytes(4096));
      await f.collect();
      expect(f.bucket.packKeys()).toEqual(packs);
      expect(f.accounting.settleHistory).toHaveBeenLastCalledWith(repoId, expect.any(Number));
      await f.clone();
    } finally { await f.close(); }
  }, 60_000);

  it("deletes nothing when part of the history cannot be read, and retries an hour later", async () => {
    const f = await fixture();
    try {
      await f.commit({ "project.txt": "first\n" }, "first");
      await f.git("push", "-q", "origin", "main");
      await f.git("push", "-q", "origin", "main:refs/heads/old");
      await f.git("push", "-q", "origin", "--delete", "old");
      await f.git("switch", "-q", "-c", "gone");
      await f.commit({ "gone.txt": "gone\n" }, "gone");
      await f.git("push", "-q", "origin", "gone");
      await f.git("push", "-q", "origin", "--delete", "gone");
      const objects = new Map(f.bucket.objects);
      f.bucket.failReads = (key) => key.endsWith(".pack");
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await f.collect();
      expect(error).toHaveBeenCalledWith("Git history collection failed", expect.objectContaining({ repoId }));
      error.mockRestore();
      expect([...f.bucket.objects.keys()].filter((key) => key.startsWith(objectsPrefix)))
        .toEqual([...objects.keys()].filter((key) => key.startsWith(objectsPrefix)));
      const retryAt = (await f.storage.get<number>("historyCollectionAt"))!;
      expect(retryAt).toBeGreaterThan(Date.now() + 59 * 60_000);
      // An earlier alarm that takes the retry's place leaves the retry scheduled.
      f.storage.alarm = null;
      await f.collect();
      expect(f.storage.alarm).toBe(retryAt);

      // An hour later the readable history is collected.
      f.bucket.failReads = undefined;
      await f.storage.delete("historyCollectionAt");
      await f.collect();
      expect(f.bucket.packKeys()).toHaveLength(2);
      await f.clone();
    } finally { await f.close(); }
  }, 60_000);
});
