import { expect, it } from "vitest";
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
class Bucket {
  objects = new Map<string, Uint8Array>();
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
}

/** Native Git against one in-process repository object, with config isolated from the developer's. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "beutl-git-fetch-"));
  const values = new Map<string, unknown>();
  const storage = { get: async (key: string) => values.get(key), put: async (key: string, value: unknown) => { values.set(key, value); },
    getAlarm: async () => null, setAlarm: async () => undefined };
  const durable = new GitRepositoryDurableObject({ storage: storage as never }, {}, new Bucket() as never);
  const uploads: { request: string; status: number; bytes: number; text: string }[] = [];
  const server = createServer(async (incoming, outgoing) => {
    try {
      const headers = new Headers({ "x-beutl-repo-id": repoId, "x-beutl-git-scope": "write", "x-beutl-git-owner-id": "owner" });
      for (const [key, value] of Object.entries(incoming.headers)) if (typeof value === "string") headers.set(key, value);
      const result = await durable.fetch(new Request(`http://127.0.0.1${incoming.url}`, {
        method: incoming.method, headers, ...(incoming.method === "POST" ? { body: Readable.toWeb(incoming), duplex: "half" } : {}),
      } as RequestInit));
      const body = new Uint8Array(await result.arrayBuffer());
      if (incoming.url?.endsWith("/git-upload-pack")) {
        uploads.push({ request: incoming.url, status: result.status, bytes: body.byteLength,
          text: new TextDecoder().decode(body.subarray(0, 4096)) });
      }
      outgoing.writeHead(result.status, Object.fromEntries(result.headers));
      outgoing.end(body);
    } catch (error) { outgoing.writeHead(500); outgoing.end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v3/git/${repoId}.git`;
  const home = join(root, "home"); mkdirSync(home);
  const env = { PATH: process.env.PATH!, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com", GIT_PROTOCOL: "" };
  const git = (cwd: string, ...args: string[]) => execute("git", args, { cwd, env, maxBuffer: 16 * 1024 * 1024 });
  const commit = async (cwd: string, name: string, content: string | Uint8Array) => {
    writeFileSync(join(cwd, name), content); await git(cwd, "add", name); await git(cwd, "commit", "-q", "-m", name);
  };
  const close = async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (!root.startsWith(tmpdir() + sep)) throw new Error("Git fixture escaped the temporary directory");
    rmSync(root, { recursive: true, force: true });
  };
  return { root, url, env, git, commit, uploads, close };
}

it("fetches only the commits a clone lacks once the server acknowledges common history", async () => {
  const f = await fixture();
  try {
    const origin = join(f.root, "origin"); mkdirSync(origin);
    await f.git(origin, "init", "-q", "-b", "main");
    await f.commit(origin, "media.bin", randomBytes(1024 * 1024));
    await f.git(origin, "remote", "add", "origin", f.url);
    await f.git(origin, "push", "-q", "origin", "main");
    const copy = join(f.root, "copy");
    await f.git(f.root, "clone", "-q", f.url, copy);
    const cloned = f.uploads.reduce((sum, upload) => sum + upload.bytes, 0);
    expect(cloned).toBeGreaterThan(1024 * 1024);

    // The copy also has an older branch the server has never seen. Git sends
    // haves newest first, so the shared commit is acknowledged in the first
    // round while the old branch keeps negotiation going for more rounds.
    await f.git(copy, "switch", "-q", "--orphan", "archive");
    const old = { ...f.env, GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z" };
    for (let n = 0; n < 40; n++) {
      writeFileSync(join(copy, "archive.txt"), `old ${n}\n`);
      await execute("git", ["add", "archive.txt"], { cwd: copy, env: old });
      await execute("git", ["commit", "-q", "-m", `old ${n}`], { cwd: copy, env: old });
    }
    await f.git(copy, "switch", "-q", "main");
    await f.commit(origin, "notes.txt", "second\n");
    await f.git(origin, "push", "-q", "origin", "main");
    f.uploads.length = 0;
    const fetched = await f.git(copy, "fetch", "origin");
    expect(fetched.stderr).not.toContain("no common commits");
    // A round without "done" acknowledges the shared commit, then "done" gets the final ACK.
    expect(f.uploads.some((upload) => /ACK [0-9a-f]{40} common\n0008NAK\n$/u.test(upload.text))).toBe(true);
    expect(f.uploads.at(-1)!.text).toMatch(/^0031ACK [0-9a-f]{40}\n/u);
    expect(f.uploads.every((upload) => upload.status === 200)).toBe(true);
    // The second fetch carries the new commit, not the 1 MiB history it shares.
    expect(f.uploads.reduce((sum, upload) => sum + upload.bytes, 0)).toBeLessThan(16 * 1024);
    await f.git(copy, "merge", "-q", "--ff-only", "origin/main");
    expect(readFileSync(join(copy, "notes.txt"), "utf8")).toBe("second\n");
    await f.git(copy, "fsck", "--no-progress");
  } finally { await f.close(); }
}, 60_000);

it("still sends a complete pack to a client that shares no history", async () => {
  const f = await fixture();
  try {
    const origin = join(f.root, "origin"); mkdirSync(origin);
    await f.git(origin, "init", "-q", "-b", "main");
    await f.commit(origin, "project.txt", "server\n");
    await f.git(origin, "remote", "add", "origin", f.url);
    await f.git(origin, "push", "-q", "origin", "main");
    const unrelated = join(f.root, "unrelated"); mkdirSync(unrelated);
    await f.git(unrelated, "init", "-q", "-b", "main");
    for (const n of [1, 2, 3]) await f.commit(unrelated, `local-${n}.txt`, `${n}\n`);
    f.uploads.length = 0;
    await f.git(unrelated, "fetch", "-q", f.url, "main:refs/remotes/server/main");
    expect(f.uploads.every((upload) => !/ACK [0-9a-f]{40}/u.test(upload.text))).toBe(true);
    expect((await f.git(unrelated, "show", "server/main:project.txt")).stdout).toBe("server\n");
    await f.git(unrelated, "fsck", "--no-progress");
  } finally { await f.close(); }
}, 60_000);

it("follows the capabilities a client requests and bounds the haves it looks up", async () => {
  const f = await fixture();
  try {
    const origin = join(f.root, "origin"); mkdirSync(origin);
    await f.git(origin, "init", "-q", "-b", "main");
    await f.commit(origin, "project.txt", "one\n");
    await f.git(origin, "remote", "add", "origin", f.url);
    await f.git(origin, "push", "-q", "origin", "main");
    const head = (await f.git(origin, "rev-parse", "HEAD")).stdout.trim();
    const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;
    const round = await fetch(`${f.url}/git-upload-pack`, { method: "POST",
      headers: { "Content-Type": "application/x-git-upload-pack-request" },
      body: `${pkt(`want ${head} side-band-64k\n`)}0000${pkt(`have ${head}\n`)}0000` });
    expect(await round.text()).toBe("0008NAK\n");
    // The capability counts at the end of the line too.
    const last = await fetch(`${f.url}/git-upload-pack`, { method: "POST",
      headers: { "Content-Type": "application/x-git-upload-pack-request" },
      body: `${pkt(`want ${head} side-band-64k multi_ack_detailed\n`)}0000${pkt(`have ${head}\n`)}0000` });
    expect(await last.text()).toBe(`0038ACK ${head} common\n0008NAK\n`);
    // Only the first 1,024 haves of a request are looked up.
    const unknown = Array.from({ length: 1024 }, (_, n) => pkt(`have ${n.toString(16).padStart(40, "0")}\n`)).join("");
    const late = await fetch(`${f.url}/git-upload-pack`, { method: "POST",
      headers: { "Content-Type": "application/x-git-upload-pack-request" },
      body: `${pkt(`want ${head} multi_ack_detailed\n`)}0000${unknown}${pkt(`have ${head}\n`)}0000` });
    expect(await late.text()).toBe("0008NAK\n");
  } finally { await f.close(); }
}, 60_000);
