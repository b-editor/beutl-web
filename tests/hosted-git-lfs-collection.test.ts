import { describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { GitRepositoryDurableObject } from "../packages/api/src/git/repo-durable-object";
import { lfsPointerOid } from "../packages/api/src/git/lfs-references";
import { lfsKey, type LfsRecord } from "../packages/api/src/git/lfs";

const execute = promisify(execFile);
const repoId = "12345678-1234-1234-1234-123456789abc";
const DAY = 24 * 60 * 60 * 1000;
const pointer = (oid: string, size = 10) => `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;

class Bucket {
  objects = new Map<string, Uint8Array>();
  reads: string[] = [];
  failReads?: (key: string) => boolean;
  failLists?: (prefix: string) => boolean;
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
    if (this.failLists?.(prefix)) throw new Error("B2 listing failed");
    const objects = [], prefixes = new Set<string>();
    for (const [key, bytes] of this.objects) if (key.startsWith(prefix)) {
      const index = delimiter ? key.slice(prefix.length).indexOf(delimiter) : -1;
      if (index >= 0) prefixes.add(key.slice(0, prefix.length + index + delimiter!.length));
      else objects.push({ key, size: bytes.length });
    }
    return { objects, delimitedPrefixes: [...prefixes], truncated: false };
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

function repository() {
  const storage = new Storage(), bucket = new Bucket();
  const accounting = { reserveHistory: vi.fn(async () => true), settleHistory: vi.fn(async () => undefined),
    reserveLfs: vi.fn(async () => "reserved"), commitLfs: vi.fn(async () => undefined), extendLfs: vi.fn(async () => undefined),
    releaseLfs: vi.fn(async () => undefined), releaseRepository: vi.fn(async () => undefined) };
  const durable = new GitRepositoryDurableObject({ storage }, {}, bucket as never, accounting as never);
  /** A published LFS object, last uploaded `age` ago, with its stored bytes. */
  const store = async (oid: string, age: number) => {
    await storage.put<LfsRecord>(`lfs:${oid}`, { size: 10, expiresAt: 0, verified: true, resourceId: crypto.randomUUID(),
      versionId: "version-1", offset: 10, partCount: 1, touchedAt: Date.now() - age });
    await bucket.put(lfsKey(repoId, oid), new Uint8Array(10));
  };
  const collect = async () => { await storage.delete("lfsCollectionAt"); await durable.alarm(); };
  const stored = async (oid: string) => (await storage.get<LfsRecord>(`lfs:${oid}`))?.verified === true &&
    bucket.objects.has(lfsKey(repoId, oid));
  return { storage, bucket, accounting, durable, store, collect, stored };
}

/** Serves the repository object to native Git with config isolated from the developer's. */
async function nativeGit(durable: GitRepositoryDurableObject, root: string) {
  const server = createServer(async (incoming, outgoing) => {
    try {
      const headers = new Headers({ "x-beutl-repo-id": repoId, "x-beutl-git-scope": "write", "x-beutl-git-owner-id": "owner" });
      for (const [key, value] of Object.entries(incoming.headers)) if (typeof value === "string") headers.set(key, value);
      const result = await durable.fetch(new Request(`http://127.0.0.1${incoming.url}`, {
        method: incoming.method, headers, ...(incoming.method === "POST" ? { body: Readable.toWeb(incoming), duplex: "half" } : {}),
      } as RequestInit));
      outgoing.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body) Readable.fromWeb(result.body as never).pipe(outgoing); else outgoing.end();
    } catch (error) { outgoing.writeHead(500); outgoing.end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const home = join(root, "home"); mkdirSync(home);
  const env = { PATH: process.env.PATH!, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
  const work = join(root, "work"); mkdirSync(work);
  const git = (...args: string[]) => execute("git", args, { cwd: work, env });
  const commit = async (files: Record<string, string | null>, message: string) => {
    for (const [name, content] of Object.entries(files)) {
      if (content === null) await git("rm", "-q", name);
      else { writeFileSync(join(work, name), content); await git("add", name); }
    }
    await git("commit", "-q", "-m", message);
  };
  await git("init", "-q", "-b", "main");
  await git("remote", "add", "origin", `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v3/git/${repoId}.git`);
  return { git, commit, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

describe("LFS pointer detection", () => {
  const oid = "a".repeat(64);
  it.each([
    ["a pointer", pointer(oid), oid],
    ["a pointer with an extension and CRLF line ends", `version https://git-lfs.github.com/spec/v1\r\next-0-foo sha256:${"b".repeat(64)}\r\noid sha256:${oid}\r\nsize 1\r\n`, oid],
    ["text that only mentions an OID", `see oid sha256:${oid} in notes`, null],
    ["a short hash", pointer("a".repeat(63)), null],
    ["a blob larger than any pointer", pointer(oid) + " ".repeat(1024), null],
  ])("reads %s", (_case, text, expected) => {
    expect(lfsPointerOid(new TextEncoder().encode(text))).toBe(expected);
  });
});

describe("unreferenced LFS collection", () => {
  it("collects only objects no branch or tag reaches after the grace period", async () => {
    const root = mkdtempSync(join(tmpdir(), "beutl-lfs-collection-")), r = repository();
    const git = await nativeGit(r.durable, root);
    const [onMain, deletedBranch, never, recent, tagged, history] = ["1", "2", "3", "4", "5", "6"].map((c) => c.repeat(64));
    try {
      await git.commit({ "history.bin": pointer(history) }, "history");
      await git.commit({ "history.bin": null, "main.bin": pointer(onMain) }, "main");
      await git.git("switch", "-q", "-c", "feature");
      await git.commit({ "feature.bin": pointer(deletedBranch) }, "feature");
      await git.git("switch", "-q", "--orphan", "release");
      await git.commit({ "tagged.bin": pointer(tagged) }, "release");
      await git.git("tag", "-a", "v1", "-m", "release");
      await git.git("push", "-q", "origin", "main", "feature", "v1");
      await git.git("push", "-q", "origin", "--delete", "feature");
      for (const oid of [onMain, deletedBranch, never, tagged, history]) await r.store(oid, 8 * DAY);
      await r.store(recent, 6 * DAY);

      await r.collect();
      for (const oid of [onMain, recent, tagged, history]) expect(await r.stored(oid), oid).toBe(true);
      for (const oid of [deletedBranch, never]) {
        expect(await r.storage.get(`lfs:${oid}`)).toBeUndefined();
        expect(r.bucket.objects.has(lfsKey(repoId, oid))).toBe(false);
        expect(r.accounting.releaseLfs).toHaveBeenCalledWith(repoId, oid);
      }
      expect(r.accounting.releaseLfs).toHaveBeenCalledTimes(2);

      // Nothing was pushed and no object became a candidate: the history is not read again.
      r.bucket.reads = [];
      await r.collect();
      expect(r.bucket.reads.filter((key) => key.startsWith("git/"))).toEqual([]);

      // Once its grace period ends, the recent object is checked and collected.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 2 * DAY);
      try { await r.collect(); } finally { vi.useRealTimers(); }
      expect(await r.storage.get(`lfs:${recent}`)).toBeUndefined();
      expect(await r.stored(onMain)).toBe(true);
    } finally {
      await git.close();
      if (!root.startsWith(tmpdir() + sep)) throw new Error("Git fixture escaped the temporary directory");
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("collects nothing when any part of the history cannot be read", async () => {
    const root = mkdtempSync(join(tmpdir(), "beutl-lfs-collection-")), r = repository();
    const git = await nativeGit(r.durable, root);
    const unreferenced = "7".repeat(64);
    try {
      await git.commit({ "main.bin": pointer("8".repeat(64)) }, "main");
      await git.git("push", "-q", "origin", "main");
      await r.store(unreferenced, 8 * DAY);
      r.bucket.failReads = (key) => key.includes("/objects/");
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await r.collect();
      expect(error).toHaveBeenCalledWith("Git LFS collection failed", expect.objectContaining({ repoId }));
      error.mockRestore();
      expect(await r.stored(unreferenced)).toBe(true);
      expect(r.accounting.releaseLfs).not.toHaveBeenCalled();
      // The next attempt waits an hour rather than walking the history every minute.
      expect(await r.storage.get<number>("lfsCollectionAt")).toBeGreaterThan(Date.now() + 59 * 60_000);
    } finally {
      await git.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("collects nothing when the refs cannot be listed, rather than treating the repository as empty", async () => {
    const root = mkdtempSync(join(tmpdir(), "beutl-lfs-collection-")), r = repository();
    const git = await nativeGit(r.durable, root);
    const onMain = "c".repeat(64);
    try {
      await git.commit({ "main.bin": pointer(onMain) }, "main");
      await git.git("push", "-q", "origin", "main");
      await r.store(onMain, 8 * DAY);
      r.bucket.failLists = (prefix) => prefix.includes("/refs/");
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await r.collect();
      expect(error).toHaveBeenCalledWith("Git LFS collection failed", expect.objectContaining({ repoId }));
      error.mockRestore();
      expect(await r.stored(onMain)).toBe(true);
    } finally {
      await git.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("keeps objects that only a packed ref reaches", async () => {
    const root = mkdtempSync(join(tmpdir(), "beutl-lfs-collection-")), r = repository();
    const git = await nativeGit(r.durable, root);
    const packedOnly = "d".repeat(64);
    try {
      await git.commit({ "main.bin": pointer(packedOnly) }, "main");
      await git.git("push", "-q", "origin", "main");
      const gitdir = `git/repos/${repoId}/repo.git/`;
      const oid = new TextDecoder().decode(r.bucket.objects.get(`${gitdir}refs/heads/main`)).trim();
      await r.bucket.delete(`${gitdir}refs/heads/main`);
      await r.bucket.put(`${gitdir}packed-refs`, new TextEncoder().encode(`# pack-refs with: peeled fully-peeled sorted\n${oid} refs/heads/main\n`));
      await r.store(packedOnly, 8 * DAY);
      await r.collect();
      expect(await r.stored(packedOnly)).toBe(true);
    } finally {
      await git.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("collects objects of a repository that was never pushed, without creating one", async () => {
    const r = repository(), oid = "9".repeat(64), fresh = "a".repeat(64);
    await r.storage.put("repoId", repoId);
    await r.store(oid, 8 * DAY);
    // Records published before collection existed start their grace period now.
    await r.storage.put<LfsRecord>(`lfs:${fresh}`, { size: 10, expiresAt: 0, verified: true,
      resourceId: crypto.randomUUID(), versionId: "version-1", offset: 10, partCount: 1 });
    await r.collect();
    expect(await r.storage.get(`lfs:${oid}`)).toBeUndefined();
    expect((await r.storage.get<LfsRecord>(`lfs:${fresh}`))!.touchedAt).toBeGreaterThan(Date.now() - 60_000);
    expect([...r.bucket.objects.keys()].filter((key) => key.startsWith("git/"))).toEqual([]);
  });

  it("restarts the grace period of a stored object whenever an upload batch offers it", async () => {
    const r = repository(), oid = "b".repeat(64);
    await r.storage.put("repoId", repoId);
    await r.store(oid, 8 * DAY);
    const batch = await r.durable.fetch(new Request(`https://beutl.test/api/v3/git/${repoId}.git/info/lfs/objects/batch`, {
      method: "POST", headers: { "x-beutl-repo-id": repoId, "x-beutl-git-scope": "write", "x-beutl-git-owner-id": "owner" },
      body: JSON.stringify({ operation: "upload", objects: [{ oid, size: 10 }] }),
    }));
    expect((await batch.json()).objects).toEqual([{ oid, size: 10 }]);
    await r.collect();
    expect(await r.stored(oid)).toBe(true);
  });
});
