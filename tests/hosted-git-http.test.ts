import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { GitRepositoryDurableObject } from "../packages/api/src/git/repo-durable-object";
import { handleGitHttp } from "../packages/api/src/git/git-http";

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
it("rejects unsupported Git routes before creating unreserved objects", async () => {
  const bucket = new Bucket();
  for (const [method, path] of [["GET", "config"], ["HEAD", "info/refs"], ["POST", "unknown"]]) {
    const response = await handleGitHttp(new Request(`https://git.internal/api/v3/git/${repoId}.git/${path}`, { method }),
      bucket as never, repoId, "write");
    expect(response.status).toBe(404);
  }
  expect(bucket.objects.size).toBe(0);
});
it("pushes, clones, pushes again, pulls, and rejects a stale native Git push", async () => {
  const root = mkdtempSync(join(tmpdir(), "beutl-hosted-git-")), bucket = new Bucket();
  const values = new Map<string, unknown>();
  const storage = { get: async (key: string) => values.get(key), put: async (key: string, value: unknown) => { values.set(key, value); },
    getAlarm: async () => null, setAlarm: async () => undefined };
  const durable = new GitRepositoryDurableObject({ storage: storage as never }, {}, bucket as never);
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
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v3/git/${repoId}.git`;
  const git = (cwd: string, ...args: string[]) => execute("git", args, { cwd });
  const commit = (cwd: string) => git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--no-gpg-sign", "-m", "test");
  try {
    await git(root, "init", "-b", "main"); writeFileSync(join(root, "project.txt"), "one\n");
    await git(root, "add", "project.txt"); await commit(root); await git(root, "remote", "add", "origin", url);
    await git(root, "push", "-u", "origin", "main");
    const copy = join(root, "copy"); await git(root, "clone", url, copy);
    expect(readFileSync(join(copy, "project.txt"), "utf8").trim()).toBe("one");
    writeFileSync(join(root, "project.txt"), "two\n"); await git(root, "add", "project.txt"); await commit(root);
    await git(root, "push", "origin", "main"); await git(copy, "pull", "--ff-only");
    expect(readFileSync(join(copy, "project.txt"), "utf8").trim()).toBe("two");
    writeFileSync(join(copy, "from-copy.txt"), "copy"); await git(copy, "add", "from-copy.txt"); await commit(copy);
    writeFileSync(join(root, "from-original.txt"), "original"); await git(root, "add", "from-original.txt"); await commit(root);
    await git(root, "push", "origin", "main"); await expect(git(copy, "push", "origin", "main")).rejects.toThrow();
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (!root.startsWith(tmpdir() + sep)) throw new Error("Git fixture escaped the temporary directory");
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
