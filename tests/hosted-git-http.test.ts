import { expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { GitRepositoryDurableObject } from "../packages/api/src/git/repo-durable-object";
import { receiveGitPack } from "../packages/api/src/git/git-http";
import { createGitPack, packEntryHeader } from "../packages/api/src/git/pack-writer";

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

function blobOid(data: Uint8Array) {
  return createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
}
function unsigned(value: number): Buffer {
  const bytes = [];
  do { bytes.push((value & 127) | (value >= 128 ? 128 : 0)); value = Math.floor(value / 128); } while (value);
  return Buffer.from(bytes);
}
function pushBody(entries: { data: Uint8Array; type?: number; size?: number; base?: Uint8Array; compressed?: Uint8Array }[], oid = "1".repeat(40)) {
  const header = Buffer.alloc(12); header.write("PACK"); header.writeUInt32BE(2, 4); header.writeUInt32BE(entries.length, 8);
  const pack = Buffer.concat([header, ...entries.flatMap(({ data, type = 3, size = data.length, base, compressed }) => [
    packEntryHeader(type, size), ...(base ? [base] : []), compressed ?? deflateSync(data),
  ])]);
  const update = `${"0".repeat(40)} ${oid} refs/tags/test-${oid}\0report-status\n`;
  return Buffer.concat([Buffer.from(`${(Buffer.byteLength(update) + 4).toString(16).padStart(4, "0")}${update}0000`),
    pack, createHash("sha1").update(pack).digest()]);
}
async function receive(bucket: Bucket, body: Uint8Array, reserve = vi.fn(async (_bytes: number) => true)) {
  return receiveGitPack(new Request("https://git.example.test/git-receive-pack", { method: "POST", body }),
    bucket as never, repoId, reserve);
}

it.each([false, true])("rejects the compressed 24 MiB blob before pack storage (forged size=%s)", async (forged) => {
  const bucket = new Bucket(), reserve = vi.fn(async () => true);
  const body = pushBody([{ data: Buffer.alloc(24 * 1024 * 1024), ...(forged ? { size: 1 } : {}) }]);
  expect(body.byteLength).toBeLessThan(32 * 1024);
  expect((await receive(bucket, body, reserve)).status).toBe(413);
  expect(reserve).not.toHaveBeenCalled();
  expect([...bucket.objects.keys()].some((key) => key.endsWith(".pack"))).toBe(false);
});

it("bounds the aggregate expanded pack size", async () => {
  const body = pushBody([{ data: Buffer.alloc(9 * 1024 * 1024) }, { data: Buffer.alloc(9 * 1024 * 1024, 1) }]);
  expect((await receive(new Bucket(), body)).status).toBe(413);
});

function literalDelta(operations: number) {
  return Buffer.concat([unsigned(1), unsigned(operations),
    Buffer.alloc(operations * 2).fill(Buffer.from([1, 97]))]);
}

it.each([65_537, 262_144])("accepts a valid delta with %s insert operations", async (operations) => {
  const data = Buffer.from("x"), target = Buffer.alloc(operations, 97);
  const body = pushBody([{ data }, {
    type: 7, base: Buffer.from(blobOid(data), "hex"), data: literalDelta(operations),
  }], blobOid(target));
  const response = await receive(new Bucket(), body);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain(`ok refs/tags/test-${blobOid(target)}`);
});

it.each([{ counts: [262_145] }, { counts: [131_072, 131_073] }])("bounds delta operations across the pack: $counts", async ({ counts }) => {
  const bucket = new Bucket(), reserve = vi.fn(async () => true), data = Buffer.from("x");
  const body = pushBody([{ data }, ...counts.map((operations) => ({
    type: 7, base: Buffer.from(blobOid(data), "hex"), data: literalDelta(operations),
  }))]);
  const response = await receive(bucket, body, reserve);
  expect(response.status).toBe(413);
  expect(await response.text()).toContain("delta operation budget");
  expect(reserve).not.toHaveBeenCalled();
  expect([...bucket.objects.keys()].some((key) => key.endsWith(".pack"))).toBe(false);
});

it.each([6, 7])("rejects oversized delta output for pack type %s", async (type) => {
  const data = Buffer.from("a"), header = packEntryHeader(3, data.length), compressed = deflateSync(data);
  const base = type === 7 ? Buffer.from(blobOid(data), "hex") : Buffer.from([header.length + compressed.length]);
  const delta = Buffer.concat([unsigned(1), unsigned(24 * 1024 * 1024), Buffer.from([1, 97])]);
  expect((await receive(new Bucket(), pushBody([{ data }, { type, base, data: delta }]))).status).toBe(413);
});

it("rejects delta instructions that exceed the declared output and truncated streams", async () => {
  const data = Buffer.from("a"), base = Buffer.from(blobOid(data), "hex");
  const delta = Buffer.from([1, 1, 2, 97, 98]);
  expect((await receive(new Bucket(), pushBody([{ data }, { type: 7, base, data: delta }]))).status).toBe(400);
  const body = pushBody([{ data }]);
  expect((await receive(new Bucket(), body.subarray(0, body.length - 24))).status).toBe(400);
  const compressed = deflateSync(data);
  expect((await receive(new Bucket(), pushBody([{ data, compressed: compressed.subarray(0, -1) }]))).status).toBe(400);
  compressed[0] = 0;
  expect((await receive(new Bucket(), pushBody([{ data, compressed }]))).status).toBe(400);
});

it("rejects a nonempty pack checksum mismatch before reserving or storing the pack", async () => {
  const bucket = new Bucket(), reserve = vi.fn(async () => true), data = Buffer.from("valid blob");
  const body = pushBody([{ data }], blobOid(data));
  body[body.length - 1] ^= 1;
  const response = await receive(bucket, body, reserve);
  expect(response.status).toBe(400);
  expect(await response.text()).toBe("Invalid Git pack");
  expect(reserve).not.toHaveBeenCalled();
  expect([...bucket.objects.keys()].some((key) => key.endsWith(".pack"))).toBe(false);
});

it("rejects preset-dictionary zlib streams before reserving or storing the pack", async () => {
  const bucket = new Bucket(), reserve = vi.fn(async () => true), data = Buffer.from("dictionary-backed object");
  const compressed = deflateSync(data, { dictionary: data });
  const response = await receive(bucket, pushBody([{ data, compressed }], blobOid(data)), reserve);
  expect(response.status).toBe(400);
  expect(await response.text()).toBe("Invalid Git pack");
  expect(reserve).not.toHaveBeenCalled();
  expect([...bucket.objects.keys()].some((key) => key.endsWith(".pack"))).toBe(false);
});

it("rejects a thin delta referencing an oversized legacy blob", async () => {
  const bucket = new Bucket(), oid = "a".repeat(40);
  const legacy = Buffer.alloc(24 * 1024 * 1024);
  await bucket.put(`git/repos/${repoId}/repo.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`,
    deflateSync(Buffer.concat([Buffer.from(`blob ${legacy.length}\0`), legacy])));
  const delta = Buffer.from([1, 1, 1, 97]);
  expect((await receive(bucket, pushBody([{ data: delta, type: 7, base: Buffer.from(oid, "hex") }]))).status).toBe(413);
});

it("bounds thin-base lookups across cached pack indexes before reserving or storing the pack", async () => {
  const bucket = new Bucket(), reserve = vi.fn(async () => true);
  for (let i = 0; i < 128; i++) {
    const data = Buffer.from(`stored blob ${i}`);
    const pack = createGitPack([{ oid: blobOid(data), entry: { type: 3, size: data.length, data: deflateSync(data) } }], { index: true });
    const path = `git/repos/${repoId}/repo.git/objects/pack/pack-${pack.checksum}`;
    await bucket.put(`${path}.pack`, new Uint8Array(await new Response(pack.stream()).arrayBuffer()));
    await bucket.put(`${path}.idx`, pack.index!);
  }
  // Zero-output deltas do no reconstruction work, but each missing base scans
  // every stored index, even after all index files have been cached.
  const entries = Array.from({ length: 512 }, (_, i) => ({
    type: 7, base: Buffer.from((i + 1).toString(16).padStart(40, "0"), "hex"), data: Buffer.from([0, 0]),
  }));
  const response = await receive(bucket, pushBody(entries), reserve);
  expect(response.status).toBe(413);
  expect(await response.text()).toContain("base lookup budget");
  expect(reserve).not.toHaveBeenCalled();
  expect([...bucket.objects.keys()].filter((key) => key.endsWith(".pack"))).toHaveLength(128);
});

it("counts cached delta-chain visits against the shared thin-base lookup budget", async () => {
  const bucket = new Bucket(), reserve = vi.fn(async () => true);
  const contents = Array.from({ length: 400 }, (_, i) => Buffer.from(`stored blob ${i}`));
  const entries = contents.map((content, i) => {
    const data = i === 0 ? content : Buffer.concat([
      unsigned(contents[i - 1].length), unsigned(content.length), Buffer.from([content.length]), content,
    ]);
    return { oid: blobOid(content), entry: { type: i === 0 ? 3 : 7, size: data.length,
      base: i === 0 ? undefined : blobOid(contents[i - 1]), data: deflateSync(data) } };
  });
  const pack = createGitPack(entries, { index: true });
  const path = `git/repos/${repoId}/repo.git/objects/pack/pack-${pack.checksum}`;
  await bucket.put(`${path}.pack`, new Uint8Array(await new Response(pack.stream()).arrayBuffer()));
  await bucket.put(`${path}.idx`, pack.index!);
  const body = pushBody(contents.slice(1).map((content) => ({
    type: 7, base: Buffer.from(blobOid(content), "hex"), data: Buffer.concat([unsigned(content.length), unsigned(0)]),
  })));
  const response = await receive(bucket, body, reserve);
  expect(response.status).toBe(413);
  expect(await response.text()).toContain("base lookup budget");
  expect(reserve).not.toHaveBeenCalled();
  expect([...bucket.objects.keys()].filter((key) => key.endsWith(".pack"))).toHaveLength(1);
});

it("preserves storage failures while inspecting a thin pack base", async () => {
  const bucket = new Bucket();
  vi.spyOn(bucket, "get").mockImplementation(async (key) => {
    if (key.includes("/objects/")) throw new Error("storage unavailable");
    return null;
  });
  const delta = Buffer.from([1, 1, 1, 97]);
  await expect(receive(bucket, pushBody([{ data: delta, type: 7, base: Buffer.alloc(20, 1) }])))
    .rejects.toThrow("storage unavailable");
});

it("accepts ordinary objects and a thin delta referencing stored history", async () => {
  const bucket = new Bucket(), data = Buffer.from("base"), target = Buffer.from("base!");
  let response = await receive(bucket, pushBody([{ data }], blobOid(data)));
  expect(await response.text()).toContain("unpack ok");
  const delta = Buffer.from([4, 5, 0x90, 4, 1, 33]);
  response = await receive(bucket, pushBody([{ data: delta, type: 7, base: Buffer.from(blobOid(data), "hex") }], blobOid(target)));
  expect(response.status).toBe(200);
  expect(await response.text()).toContain(`ok refs/tags/test-${blobOid(target)}`);
});
function memoryStorage() {
  const values = new Map<string, unknown>();
  return { values, get: async (key: string) => values.get(key), put: async (key: string, value: unknown) => { values.set(key, value); },
    getAlarm: async () => null, setAlarm: async () => undefined };
}
it("rejects unsupported Git routes and services before creating unreserved objects", async () => {
  const bucket = new Bucket();
  const durable = new GitRepositoryDurableObject({ storage: memoryStorage() as never }, {}, bucket as never);
  const send = (method: string, path: string, scope = "write") => durable.fetch(new Request(
    `https://git.internal/api/v3/git/${path}`, { method, headers: { "x-beutl-repo-id": repoId, "x-beutl-git-scope": scope } }));
  for (const [method, path] of [["GET", "config"], ["DELETE", "info/refs"], ["POST", "unknown"], ["GET", "git-upload-pack"]]) {
    expect((await send(method, `${repoId}.git/${path}`)).status).toBe(404);
  }
  // The object serves only the repository bound by the Worker's verified headers.
  expect((await send("GET", `${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}.git/info/refs?service=git-upload-pack`)).status).toBe(404);
  expect((await send("GET", `${repoId}.git/info/refs?service=git-unknown`)).status).toBe(400);
  expect((await send("GET", `${repoId}.git/info/refs?service=git-receive-pack`, "read")).status).toBe(403);
  expect((await send("POST", `${repoId}.git/git-receive-pack`, "read")).status).toBe(403);
  expect((await send("GET", `${repoId}.git/info/refs?service=git-upload-pack`, "admin")).status).toBe(403);
  expect(bucket.objects.size).toBe(0);
});
it("validates the advertised service before reserving storage for an empty repository", async () => {
  const bucket = new Bucket();
  const accounting = { reserveHistory: vi.fn(async () => true), settleHistory: vi.fn(async () => undefined) };
  const durable = new GitRepositoryDurableObject({ storage: memoryStorage() as never }, {}, bucket as never, accounting as never);
  const advertise = (query: string, scope: string) => durable.fetch(new Request(
    `https://git.internal/api/v3/git/${repoId}.git/info/refs${query}`,
    { headers: { "x-beutl-repo-id": repoId, "x-beutl-git-scope": scope, "x-beutl-git-owner-id": "owner" } }));
  expect((await advertise("?service=git-unknown", "write")).status).toBe(400);
  expect((await advertise("", "write")).status).toBe(400);
  expect((await advertise("?service=git-receive-pack", "read")).status).toBe(403);
  expect(accounting.reserveHistory).not.toHaveBeenCalled();
  expect(bucket.objects.size).toBe(0);
  // A valid advertisement reserves the initialization before writing HEAD/config.
  expect((await advertise("?service=git-upload-pack", "read")).status).toBe(200);
  expect(accounting.reserveHistory).toHaveBeenCalledWith(repoId, "owner", 4096);
  expect(bucket.objects.size).toBeGreaterThan(0);
});
it("waits a full second after the previous push before writing Git objects to B2", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(10_000);
    const bucket = new Bucket();
    const put = vi.spyOn(bucket, "put");
    const values = new Map<string, unknown>([["lastPushFinishedAt", 9_750]]);
    const storage = { get: async (key: string) => values.get(key), put: async (key: string, value: unknown) => { values.set(key, value); },
      getAlarm: async () => null, setAlarm: async () => undefined };
    const durable = new GitRepositoryDurableObject({ storage: storage as never }, {}, bucket as never);
    const pending = durable.fetch(new Request(`https://git.internal/api/v3/git/${repoId}.git/git-receive-pack`, {
      method: "POST", headers: { "x-beutl-repo-id": repoId, "x-beutl-git-scope": "write" }, body: "0000",
    }));
    await vi.advanceTimersByTimeAsync(749);
    expect(put).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(put).toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
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
