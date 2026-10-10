import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import isomorphicGit from "../packages/api/node_modules/isomorphic-git/index.js";
import { GitRepositoryDurableObject } from "../packages/api/src/git/repo-durable-object";
import { lfsKey, type LfsRecord } from "../packages/api/src/git/lfs";
import {
  listRepositoryCommits,
  listRepositoryRefs,
  readRepositoryFile,
  readRepositoryPath,
} from "../packages/api/src/git/repository-browser";

const execute = promisify(execFile);
const repoId = "12345678-1234-1234-1234-123456789abc";
const access = { repoId, ownerId: "owner", scope: "read" as const };
const media = { oid: "a".repeat(64), size: 123_456_789 };
const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${media.oid}\nsize ${media.size}\n`;
const still = randomBytes(300);
// Text that quotes a pointer without the version line is not one.
const quoted = `see oid sha256:${media.oid}\nsize ${media.size}\n`;
const largeFiles = Object.fromEntries(Array.from({ length: 8 }, (_, i) =>
  [`large/file-${i}.bin`, Buffer.alloc(256 * 1024, i)]));

class Bucket {
  objects = new Map<string, Uint8Array>();
  downloads: { key: string; versionId: string; range?: string }[] = [];
  async get(key: string) {
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
  /** Stands in for the B2 version an LFS download streams. */
  async download(key: string, versionId: string, _method: string, range?: string) {
    this.downloads.push({ key, versionId, range });
    return new Response("media", { status: range ? 206 : 200, headers: {
      "Content-Length": "5", ...(range ? { "Content-Range": `bytes 0-4/${media.size}` } : {}),
    } });
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

const storage = new Storage(), bucket = new Bucket();
const accounting = { reserveHistory: vi.fn(async () => true), settleHistory: vi.fn(async () => undefined),
  reserveLfs: vi.fn(async () => "reserved"), commitLfs: vi.fn(async () => undefined), extendLfs: vi.fn(async () => undefined),
  releaseLfs: vi.fn(async () => undefined), releaseRepository: vi.fn(async () => undefined) };
const durable = new GitRepositoryDurableObject({ storage }, {}, bucket as never, accounting as never);
// The dashboard reaches the repository object through this binding.
const env = { BEUTL_GIT_REPOSITORIES: { idFromName: (name: string) => name, get: () => ({ fetch: (r: Request) => durable.fetch(r) }) } };
const commits: Record<string, string> = {};
let root: string, server: Server;
let git: (...args: string[]) => Promise<string>;
let commit: (files: Record<string, string | Uint8Array>, message: string) => Promise<string>;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "beutl-git-browse-"));
  server = createServer(async (incoming, outgoing) => {
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
  const home = join(root, "home"); mkdirSync(home);
  const work = join(root, "work"); mkdirSync(work);
  const gitEnv = { PATH: process.env.PATH!, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Author", GIT_AUTHOR_EMAIL: "author@example.com",
    GIT_COMMITTER_NAME: "Author", GIT_COMMITTER_EMAIL: "author@example.com" };
  git = async (...args: string[]) => (await execute("git", args, { cwd: work, env: gitEnv })).stdout.trim();
  commit = async (files: Record<string, string | Uint8Array>, message: string) => {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(work, name, ".."), { recursive: true });
      writeFileSync(join(work, name), content);
      await git("add", name);
    }
    await git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  await git("init", "-q", "-b", "main");
  commits.first = await commit({ "README.md": "# Project\n" }, "first");
  await git("tag", "-a", "v1", "-m", "release");
  commits.second = await commit({ "assets/clip.mp4": pointer, "assets/still.png": still, "project/Project.bep": "{}\n",
    "project/notes.txt": quoted, ...largeFiles }, "add media\n\nbody");
  commits.third = await commit({ "README.md": "# Project\n\nUpdated\n" }, "update readme");
  await git("switch", "-q", "-c", "feature");
  commits.feature = await commit({ "notes.txt": "feature\n" }, "feature");
  await git("switch", "-q", "main");
  // A tag that shares the branch's name points elsewhere.
  await git("tag", "feature", commits.first);
  await git("remote", "add", "origin", `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v3/git/${repoId}.git`);
  await git("push", "-q", "origin", "refs/heads/main", "refs/heads/feature", "refs/tags/v1", "refs/tags/feature");
}, 60_000);

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (!root.startsWith(tmpdir() + sep)) throw new Error("Git fixture escaped the temporary directory");
  rmSync(root, { recursive: true, force: true });
});

describe("browsing a hosted repository", () => {
  it("lists branches and tags with the branch HEAD names", async () => {
    expect(await listRepositoryRefs(env, access)).toEqual({
      defaultBranch: "main",
      branches: [{ name: "feature", oid: commits.feature }, { name: "main", oid: commits.third }],
      tags: [{ name: "feature", oid: commits.first }, { name: "v1", oid: expect.stringMatching(/^[0-9a-f]{40}$/u) }],
    });
  });

  it("lists a directory with folders first and describes LFS pointers by their media", async () => {
    const top = await readRepositoryPath(env, access, "main", "");
    expect(top).toMatchObject({ kind: "tree", commit: commits.third, path: "" });
    expect(top?.kind === "tree" && top.entries.map((entry) => [entry.name, entry.type])).toEqual([
      ["assets", "tree"], ["large", "tree"], ["project", "tree"], ["README.md", "blob"],
    ]);
    const assets = await readRepositoryPath(env, access, "main", "assets");
    expect(assets?.kind === "tree" && assets.entries).toEqual([
      { name: "clip.mp4", path: "assets/clip.mp4", type: "blob", oid: expect.any(String), size: pointer.length, lfs: media },
      { name: "still.png", path: "assets/still.png", type: "blob", oid: expect.any(String), size: still.length },
    ]);
  });

  it("lists pushed files by metadata without inflating their contents", async () => {
    const read = vi.spyOn(isomorphicGit, "readObject");
    try {
      const view = await readRepositoryPath(env, access, "main", "large");
      expect(view?.kind).toBe("tree");
      if (view?.kind !== "tree") throw new Error("Missing large-file directory");
      expect(view.entries.map((entry) => [entry.name, entry.size])).toEqual(
        Object.entries(largeFiles).map(([name, bytes]) => [name.slice("large/".length), bytes.byteLength]),
      );
      const blobs = new Set(view.entries.map((entry) => entry.oid));
      expect(read.mock.calls.filter(([options]) => blobs.has(options.oid))).toEqual([]);
    } finally { read.mockRestore(); }
  });

  it("returns HEAD and small ranges for ordinary files without buffering the complete body", async () => {
    const file = (method: string, range?: string) => readRepositoryFile(env, access,
      new Request("http://dashboard.test/content", { method, headers: range ? { Range: range } : undefined }),
      "main", "large/file-1.bin", bucket as never);
    const head = await file("HEAD");
    expect(head?.response.body).toBeNull();
    expect(head?.response.headers.get("content-length")).toBe(String(256 * 1024));
    const range = await file("GET", "bytes=0-0");
    expect(range?.response.status).toBe(206);
    expect(range?.response.headers.get("content-length")).toBe("1");
    expect(new Uint8Array(await range!.response.arrayBuffer())).toEqual(new Uint8Array([1]));
  });

  it("names one file, follows annotated tags and commit IDs, and reports what does not exist", async () => {
    expect(await readRepositoryPath(env, access, "main", "project/Project.bep"))
      .toMatchObject({ kind: "blob", entry: { name: "Project.bep", path: "project/Project.bep", type: "blob", size: 3 } });
    const tagged = await readRepositoryPath(env, access, "v1", "");
    expect(tagged?.commit).toBe(commits.first);
    expect(tagged?.kind === "tree" && tagged.entries.map((entry) => entry.name)).toEqual(["README.md"]);
    expect((await readRepositoryPath(env, access, commits.second, "assets"))?.commit).toBe(commits.second);
    // A short name is the branch; the full name picks the tag that shares it.
    expect((await readRepositoryPath(env, access, "feature", ""))?.commit).toBe(commits.feature);
    expect((await readRepositoryPath(env, access, "refs/tags/feature", ""))?.commit).toBe(commits.first);
    expect((await readRepositoryPath(env, access, "refs/heads/feature", ""))?.commit).toBe(commits.feature);
    expect(await readRepositoryPath(env, access, "refs/tags/missing", "")).toBeNull();
    // Only a pointer as Git LFS writes it counts; quoting one leaves text.
    const notes = await readRepositoryPath(env, access, "main", "project/notes.txt");
    expect(notes).toMatchObject({ kind: "blob", entry: { name: "notes.txt", size: quoted.length } });
    expect(notes?.kind === "blob" && "lfs" in notes.entry).toBe(false);
    expect(await readRepositoryPath(env, access, "main", "missing.txt")).toBeNull();
    expect(await readRepositoryPath(env, access, "main", "README.md/inside")).toBeNull();
    expect(await readRepositoryPath(env, access, "nothing", "")).toBeNull();
    expect(await readRepositoryPath(env, access, "f".repeat(40), "")).toBeNull();
  });

  it("pages first-parent history newest first", async () => {
    const page = await listRepositoryCommits(env, access, "main");
    expect(page?.commits.map((commit) => commit.oid)).toEqual([commits.third, commits.second, commits.first]);
    expect(page?.commits[1]).toMatchObject({ message: "add media\n\nbody\n", authorName: "Author", authorEmail: "author@example.com",
      parents: [commits.first], authoredAt: expect.stringMatching(/Z$/u) });
    expect(page?.next).toBeNull();
    const rest = await listRepositoryCommits(env, access, "main", commits.second);
    expect(rest?.commits.map((commit) => commit.oid)).toEqual([commits.second, commits.first]);
    expect(await listRepositoryCommits(env, access, "nothing")).toBeNull();
  });

  it("serves a stored file with byte ranges, and LFS media from its pinned version", async () => {
    const file = (path: string, headers?: HeadersInit) =>
      readRepositoryFile(env, access, new Request("http://dashboard.test/content", { headers }), "main", path, bucket as never);
    const whole = await file("assets/still.png");
    expect(whole?.response.status).toBe(200);
    expect(new Uint8Array(await whole!.response.arrayBuffer())).toEqual(new Uint8Array(still));
    const part = await file("assets/still.png", { Range: "bytes=10-19" });
    expect(part?.response.status).toBe(206);
    expect(part?.response.headers.get("content-range")).toBe(`bytes 10-19/${still.length}`);
    expect(new Uint8Array(await part!.response.arrayBuffer())).toEqual(new Uint8Array(still.subarray(10, 20)));
    expect((await file("assets/still.png", { Range: "bytes=999-" }))?.response.status).toBe(416);
    expect(await file("assets")).toBeNull();
    expect(await (await file("project/notes.txt"))!.response.text()).toBe(quoted);

    // The media object is served only once its upload was verified.
    expect((await file("assets/clip.mp4"))?.response.status).toBe(404);
    await storage.put<LfsRecord>(`lfs:${media.oid}`, { size: media.size, expiresAt: 0, verified: true,
      resourceId: crypto.randomUUID(), versionId: "version-1", offset: media.size, partCount: 1 });
    const clip = await file("assets/clip.mp4", { Range: "bytes=0-4" });
    expect(clip?.entry.lfs).toEqual(media);
    expect(clip?.response.status).toBe(206);
    expect(bucket.downloads.at(-1)).toEqual({ key: lfsKey(repoId, media.oid), versionId: "version-1", range: "bytes=0-4" });
  });

  it("reads each stored file once while someone browses, and reads again after a push", async () => {
    // Each bucket request is a round trip from the repository object to B2.
    const requests = () => [
      ...vi.mocked(bucket.get).mock.calls.map(([key]) => `get ${key}`),
      ...vi.mocked(bucket.list).mock.calls.map(([options]) => `list ${JSON.stringify(options)}`),
      ...vi.mocked(bucket.head).mock.calls.map(([key]) => `head ${key}`),
    ];
    vi.spyOn(bucket, "get"); vi.spyOn(bucket, "list"); vi.spyOn(bucket, "head");
    const browse = async () => {
      const refs = await listRepositoryRefs(env, access);
      return { refs, top: await readRepositoryPath(env, access, "later", "") };
    };
    expect((await listRepositoryRefs(env, access)).branches.map((branch) => branch.name)).toEqual(["feature", "main"]);

    await git("switch", "-q", "-c", "later");
    commits.later = await commit({ "later.txt": "later\n" }, "later");
    await git("push", "-q", "origin", "refs/heads/later");
    vi.clearAllMocks();
    // The push dropped what the dashboard had read, so the new branch shows.
    const { refs, top } = await browse();
    expect(refs.branches.map((branch) => branch.name)).toEqual(["feature", "later", "main"]);
    expect(top?.kind === "tree" && top.entries.map((entry) => entry.name)).toContain("later.txt");
    const first = requests();
    expect(first.length).toBeGreaterThan(0);
    expect(new Set(first).size).toBe(first.length);

    vi.clearAllMocks();
    expect(await browse()).toEqual({ refs, top });
    expect(requests()).toEqual([]);
    vi.restoreAllMocks();
  });
});
