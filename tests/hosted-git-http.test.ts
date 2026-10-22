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
import { advertiseGitRefs, MAX_GIT_REPOSITORY_BYTES, readGitRepository, receiveGitPack, uploadGitPack } from "../packages/api/src/git/git-http";
import { createGitPack, packEntryHeader } from "../packages/api/src/git/pack-writer";
import { validateGitPack } from "../packages/api/src/git/pack-validation";
import { GitObjectReader } from "../packages/api/src/git/object-reader";

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

// Frame requests independently from the server encoder, as an external Git client does.
function refCommand(ref: string, before: string, after: string, capabilities = "report-status") {
  const line = `${before} ${after} ${ref}\0${capabilities}\n`;
  return Buffer.from(`${(Buffer.byteLength(line) + 4).toString(16).padStart(4, "0")}${line}0000`);
}
function packedObject(type: "commit" | "tree" | "blob" | "tag", data: Uint8Array) {
  return { type: { commit: 1, tree: 2, blob: 3, tag: 4 }[type], data,
    oid: createHash("sha1").update(`${type} ${data.length}\0`).update(data).digest("hex") };
}
function commitObject(tree: string, parent?: string) {
  return packedObject("commit", Buffer.from(`tree ${tree}\n${parent ? `parent ${parent}\n` : ""}`
    + "author Test <test@example.com> 1 +0000\ncommitter Test <test@example.com> 1 +0000\n\nCommit\n"));
}
it.each(["HEAD", "refs/heads/../../config", "refs/heads/.hidden", "refs/heads/a.lock", "refs/heads/a..b",
  "refs/heads/a@{b}", "refs/heads/a\\b", "refs/heads/a\nb", "refs/heads/a\rb", "refs//main"])(
  "rejects an unsafe ref before writing objects: %s", async (ref) => {
    const bucket = new Bucket(), reserve = vi.fn(async () => true);
    expect((await receive(bucket, refCommand(ref, "0".repeat(40), "1".repeat(40)), reserve)).status).toBe(400);
    expect(bucket.objects.size).toBe(0); expect(reserve).not.toHaveBeenCalled();
  },
);
it.each(["zzzz", "0001", "ffff", "0010short", "0004", "0008test"])("rejects malformed push framing: %s", async (body) => {
  const bucket = new Bucket();
  expect((await receive(bucket, Buffer.from(body))).status).toBe(400);
  expect(bucket.objects.size).toBe(0);
});
it("rejects malformed fetch framing without initializing storage", async () => {
  const bucket = new Bucket();
  expect((await uploadGitPack(new Request("https://git.example.test/git-upload-pack", { method: "POST", body: "0003" }),
    bucket as never, repoId)).status).toBe(400);
  expect(bucket.objects.size).toBe(0);
});
it("preserves legacy packed refs, rejects stale updates and deletes packed tags without resurrecting them", async () => {
  const bucket = new Bucket(), root = `git/repos/${repoId}/repo.git/`, data = Buffer.from("legacy"), oid = blobOid(data);
  await bucket.put(`${root}objects/${oid.slice(0, 2)}/${oid.slice(2)}`, deflateSync(Buffer.concat([Buffer.from(`blob ${data.length}\0`), data])));
  await bucket.put(`${root}packed-refs`, Buffer.from(`# pack-refs with: peeled\n${oid} refs/tags/legacy\n^${oid}\n`));
  const advert = await advertiseGitRefs(bucket as never, repoId, "git-receive-pack");
  expect(await advert.text()).toContain(`${oid} refs/tags/legacy`);
  const stale = await receive(bucket, refCommand("refs/tags/legacy", "1".repeat(40), "0".repeat(40)));
  expect(await stale.text()).toContain("ng refs/tags/legacy stale ref");
  expect(Buffer.from(bucket.objects.get(`${root}packed-refs`)!).toString()).toContain(oid);
  const deleted = await receive(bucket, refCommand("refs/tags/legacy", oid, "0".repeat(40)));
  expect(await deleted.text()).toContain("ok refs/tags/legacy");
  expect(await (await advertiseGitRefs(bucket as never, repoId, "git-receive-pack")).text()).not.toContain("refs/tags/legacy");
});
it("does not publish a ref to an absent object", async () => {
  const bucket = new Bucket();
  expect(await (await receive(bucket, refCommand("refs/heads/missing", "0".repeat(40), "1".repeat(40)))).text())
    .toContain("ng refs/heads/missing invalid target object");
  expect([...bucket.objects.keys()].some((key) => key.includes("/refs/"))).toBe(false);
});
it.each(["tree", "parent", "blob", "tag"])("rejects incomplete incoming history with a missing %s", async (missing) => {
  const bucket = new Bucket(), reserve = vi.fn(async () => true), absent = "1".repeat(40);
  const tree = packedObject("tree", missing === "blob"
    ? Buffer.concat([Buffer.from("100644 file.txt\0"), Buffer.from(absent, "hex")]) : Buffer.alloc(0));
  const commit = commitObject(missing === "tree" ? absent : tree.oid, missing === "parent" ? absent : undefined);
  const tag = packedObject("tag", Buffer.from(`object ${absent}\ntype commit\ntag broken\n\nTag\n`));
  const target = missing === "tag" ? tag : commit, ref = missing === "tag" ? "refs/tags/broken" : "refs/heads/main";
  const packed = pushBody(missing === "tag" ? [tag] : [tree, commit], target.oid);
  const body = Buffer.concat([refCommand(ref, "0".repeat(40), target.oid), packed.subarray(packed.indexOf("PACK"))]);
  const response = await receive(bucket, body, reserve);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain(`ng ${ref} incomplete object graph`);
  expect(reserve).not.toHaveBeenCalled();
  expect([...bucket.objects.keys()].some((key) => key.endsWith(".pack") || key.includes("/refs/"))).toBe(false);
});
it("rejects incomplete stored history on a ref-only update", async () => {
  const bucket = new Bucket(), reserve = vi.fn(async () => true), commit = commitObject("1".repeat(40));
  await bucket.put(`git/repos/${repoId}/repo.git/objects/${commit.oid.slice(0, 2)}/${commit.oid.slice(2)}`,
    deflateSync(Buffer.concat([Buffer.from(`commit ${commit.data.length}\0`), commit.data])));
  const response = await receive(bucket, refCommand("refs/heads/main", "0".repeat(40), commit.oid), reserve);
  expect(await response.text()).toContain("ng refs/heads/main incomplete object graph");
  expect(reserve).not.toHaveBeenCalled();
  expect([...bucket.objects.keys()].some((key) => key.includes("/refs/"))).toBe(false);
});
it.each([false, true])("accepts incoming history sharing stored trees, parents and blobs while excluding submodule commits (loose blob=%s)", async (loose) => {
  const bucket = new Bucket(), blob = packedObject("blob", Buffer.from("stored file"));
  const tree = packedObject("tree", Buffer.concat([Buffer.from("100644 file.txt\0"), Buffer.from(blob.oid, "hex")]));
  const parent = commitObject(tree.oid);
  if (loose) await bucket.put(`git/repos/${repoId}/repo.git/objects/${blob.oid.slice(0, 2)}/${blob.oid.slice(2)}`,
    deflateSync(Buffer.concat([Buffer.from(`blob ${blob.data.length}\0`), blob.data])));
  expect(await (await receive(bucket, pushBody(loose ? [tree, parent] : [blob, tree, parent], parent.oid))).text()).toContain("ok refs/tags/");
  const nextTree = packedObject("tree", Buffer.concat([tree.data, Buffer.from("160000 submodule\0"), Buffer.alloc(20, 1)]));
  const commit = commitObject(nextTree.oid, parent.oid);
  const tag = packedObject("tag", Buffer.from(`object ${commit.oid}\ntype commit\ntag version\n\nTag\n`));
  const response = await receive(bucket, pushBody([nextTree, commit, tag], tag.oid));
  expect(await response.text()).toContain(`ok refs/tags/test-${tag.oid}`);
});
it("does not probe absent loose objects when pushing onto a packed 1,000-commit history", async () => {
  const bucket = new Bucket(), tree = packedObject("tree", Buffer.alloc(0)), history = [tree];
  let parent: string | undefined;
  for (let index = 0; index < 1000; index++) {
    const commit = commitObject(tree.oid, parent);
    history.push(commit); parent = commit.oid;
  }
  const pack = createGitPack(history.map(({ oid, type, data }) => ({
    oid, entry: { type, size: data.length, data: deflateSync(data) },
  })), { index: true });
  const root = `git/repos/${repoId}/repo.git/`, path = `${root}objects/pack/pack-1`;
  await bucket.put(`${path}.pack`, new Uint8Array(await new Response(pack.stream()).arrayBuffer()));
  await bucket.put(`${path}.idx`, pack.index!);
  await bucket.put(`${root}refs/heads/main`, Buffer.from(`${parent}\n`));
  const next = commitObject(tree.oid, parent), packed = pushBody([next], next.oid);
  const body = Buffer.concat([refCommand("refs/heads/main", parent!, next.oid), packed.subarray(packed.indexOf("PACK"))]);
  const get = vi.spyOn(bucket, "get");
  expect(await (await receive(bucket, body)).text()).toContain("ok refs/heads/main");
  const looseReads = get.mock.calls.filter(([key]) => /\/objects\/[0-9a-f]{2}\/[0-9a-f]{38}$/u.test(key));
  expect(looseReads).toHaveLength(0);
  expect(get.mock.calls.length).toBeLessThan(20);
});
it.each([{ packed: false, full: false }, { packed: true, full: false }, { packed: false, full: true }])(
  "rejects replayed stale pushes without storing or reserving history (packed=$packed, full=$full)", async ({ packed, full }) => {
    const bucket = new Bucket(), reserve = vi.fn(async () => true), data = Buffer.from("original"), oid = blobOid(data);
    const body = pushBody([{ data }], oid), root = `git/repos/${repoId}/repo.git/`, ref = `refs/tags/test-${oid}`;
    expect(await (await receive(bucket, body)).text()).toContain(`ok ${ref}`);
    if (packed) {
      await bucket.put(`${root}packed-refs`, Buffer.from(`${oid} ${ref}\n`));
      await bucket.delete(root + ref);
    }
    if (full) await bucket.put(`${root}objects/padding`, Buffer.alloc(MAX_GIT_REPOSITORY_BYTES
      - [...bucket.objects.values()].reduce((total, bytes) => total + bytes.length, 0)));
    const put = vi.spyOn(bucket, "put");
    for (let retry = 0; retry < 2; retry++) {
      const response = await receive(bucket, body, reserve);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(`ng ${ref} stale ref`);
    }
    expect(reserve).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  },
);
it("accepts valid ref updates alongside stale ones in the same push", async () => {
  const bucket = new Bucket(), reserve = vi.fn(async () => true), original = Buffer.from("original"), next = Buffer.from("next");
  const oldOid = blobOid(original), newOid = blobOid(next), oldRef = `refs/tags/test-${oldOid}`, newRef = "refs/tags/new";
  await receive(bucket, pushBody([{ data: original }], oldOid));
  const packed = pushBody([{ data: next }], newOid), command = `${"0".repeat(40)} ${newOid} ${newRef}\n`;
  const body = Buffer.concat([refCommand(oldRef, "0".repeat(40), newOid).subarray(0, -4),
    Buffer.from(`${(Buffer.byteLength(command) + 4).toString(16).padStart(4, "0")}${command}0000`),
    packed.subarray(packed.indexOf("PACK"))]);
  const status = await (await receive(bucket, body, reserve)).text();
  expect(status).toContain(`ng ${oldRef} stale ref`);
  expect(status).toContain(`ok ${newRef}`);
  const root = `git/repos/${repoId}/repo.git/`;
  expect(Buffer.from(bucket.objects.get(root + oldRef)!).toString()).toBe(`${oldOid}\n`);
  expect(Buffer.from(bucket.objects.get(root + newRef)!).toString()).toBe(`${newOid}\n`);
  expect([...bucket.objects.keys()].filter((key) => key.endsWith(".pack"))).toHaveLength(2);
  expect(reserve).toHaveBeenCalledOnce();
});
it("keeps both packs when successive pushes have the same timestamp", async () => {
  const bucket = new Bucket(), time = vi.spyOn(Date, "now").mockReturnValue(10_000);
  try {
    for (const content of ["first", "second"]) {
      const data = Buffer.from(content);
      expect(await (await receive(bucket, pushBody([{ data }], blobOid(data)))).text()).toContain("ok refs/tags/");
    }
    expect([...bucket.objects.keys()].filter((key) => key.endsWith(".pack")).map((key) => key.split("/").at(-1)))
      .toEqual(["recv-10000.pack", "recv-10001.pack"]);
    const reader = new GitObjectReader(readGitRepository(bucket as never, repoId));
    for (const content of ["first", "second"]) expect(Buffer.from(await reader.read(blobOid(Buffer.from(content)))).toString()).toBe(content);
  } finally { time.mockRestore(); }
});
it("removes an incoming pack after an index write fails and leaves existing history readable", async () => {
  const bucket = new Bucket(), original = Buffer.from("original"), next = Buffer.from("next");
  await receive(bucket, pushBody([{ data: original }], blobOid(original)));
  const before = [...bucket.objects.keys()], put = bucket.put.bind(bucket), failure = new Error("B2 index write failed");
  const failing = vi.spyOn(bucket, "put").mockImplementation(async (key, bytes) => {
    await put(key, bytes);
    if (key.endsWith(".idx")) throw failure; // The server may have stored the object before the response failed.
  });
  await expect(receive(bucket, pushBody([{ data: next }], blobOid(next)))).rejects.toBe(failure);
  failing.mockRestore();
  expect([...bucket.objects.keys()]).toEqual(before);
  const reader = new GitObjectReader(readGitRepository(bucket as never, repoId));
  expect(Buffer.from(await reader.read(blobOid(original)))).toEqual(original);
  expect(await (await receive(bucket, pushBody([{ data: next }], blobOid(next)))).text()).toContain("ok refs/tags/");
});
it.each(["base", "delta"])("removes an incomplete index for a forward REF_DELTA before publishing its %s", async (target) => {
  const bucket = new Bucket(), original = Buffer.from("original"), base = Buffer.from("a"), result = Buffer.from("ab");
  await receive(bucket, pushBody([{ data: original }], blobOid(original)));
  const before = new Map(bucket.objects), oid = blobOid(target === "base" ? base : result);
  const entries = [{ type: 7, base: Buffer.from(blobOid(base), "hex"), data: Buffer.from([1, 2, 0x90, 1, 1, 98]) }, { data: base }];
  // This valid pack passes validation, but the indexer cannot resolve a base
  // that appears later and silently omits the delta from the written index.
  await expect(receive(bucket, pushBody(entries, oid))).rejects.toThrow("Git pack index is incomplete");
  expect(bucket.objects).toEqual(before);
  const reader = new GitObjectReader(readGitRepository(bucket as never, repoId));
  expect(Buffer.from(await reader.read(blobOid(original)))).toEqual(original);
  expect(await (await receive(bucket, pushBody([...entries].reverse(), oid))).text()).toContain(`ok refs/tags/test-${oid}`);
  const recovered = new GitObjectReader(readGitRepository(bucket as never, repoId));
  expect(Buffer.from(await recovered.read(blobOid(result)))).toEqual(result);
});
it.each([false, true])("removes an incomplete index after a thin base read fails only during indexing (loose=%s)", async (loose) => {
  const bucket = new Bucket(), base = Buffer.from("a"), target = Buffer.from("ab"), baseOid = blobOid(base);
  const looseKey = `git/repos/${repoId}/repo.git/objects/${baseOid.slice(0, 2)}/${baseOid.slice(2)}`;
  if (loose) {
    await bucket.put(looseKey, deflateSync(Buffer.concat([Buffer.from("blob 1\0"), base])));
    await receive(bucket, refCommand("refs/tags/base", "0".repeat(40), baseOid));
  } else await receive(bucket, pushBody([{ data: base }], baseOid));
  const before = new Map(bucket.objects), baseKey = loose ? looseKey : [...before.keys()].find((key) => key.endsWith(".pack"))!;
  const get = bucket.get.bind(bucket), put = bucket.put.bind(bucket);
  let indexing = false, failures = 0;
  const writing = vi.spyOn(bucket, "put").mockImplementation(async (key, bytes) => {
    await put(key, bytes);
    if (key.endsWith(".pack")) indexing = true;
  });
  const reading = vi.spyOn(bucket, "get").mockImplementation(async (key) => {
    if (indexing && key === baseKey) { failures++; throw new Error("B2 base read failed"); }
    return get(key);
  });
  const body = pushBody([{ type: 7, base: Buffer.from(baseOid, "hex"), data: Buffer.from([1, 2, 0x90, 1, 1, 98]) }], blobOid(target));
  try {
    await expect(receive(bucket, body)).rejects.toThrow("Git pack index is incomplete");
  } finally { reading.mockRestore(); writing.mockRestore(); }
  expect(failures).toBeGreaterThan(0);
  expect(bucket.objects).toEqual(before);
  const reader = new GitObjectReader(readGitRepository(bucket as never, repoId));
  expect(Buffer.from(await reader.read(baseOid))).toEqual(base);
  expect(await (await receive(bucket, body)).text()).toContain(`ok refs/tags/test-${blobOid(target)}`);
  const recovered = new GitObjectReader(readGitRepository(bucket as never, repoId));
  expect(Buffer.from(await recovered.read(blobOid(target)))).toEqual(target);
});
it.each(["atomic", "push-options"])("refuses unsupported %s before accepting a push", async (capability) => {
  const bucket = new Bucket();
  expect((await receive(bucket, refCommand("refs/heads/main", "0".repeat(40), "1".repeat(40), `report-status ${capability}`))).status).toBe(400);
  expect(bucket.objects.size).toBe(0);
});
it("rejects repeated ref commands before writing any objects", async () => {
  const bucket = new Bucket(), oid = "1".repeat(40);
  const first = refCommand("refs/heads/main", "0".repeat(40), oid);
  const next = `${oid} ${"2".repeat(40)} refs/heads/main\n`;
  const body = Buffer.concat([first.subarray(0, -4), Buffer.from(`${(Buffer.byteLength(next) + 4).toString(16).padStart(4, "0")}${next}0000`)]);
  expect((await receive(bucket, body)).status).toBe(400);
  expect(bucket.objects.size).toBe(0);
});

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

it.each([
  { type: 6, operations: 87_380, children: 2, chain: false, status: 200 },
  { type: 7, operations: 87_380, children: 2, chain: false, status: 200 },
  { type: 6, operations: 87_381, children: 2, chain: false, status: 413 },
  { type: 7, operations: 87_381, children: 2, chain: false, status: 413 },
  { type: 6, operations: 87_380, children: 2, chain: true, status: 413 },
  { type: 7, operations: 87_380, children: 2, chain: true, status: 413 },
  { type: 7, operations: 250_000, children: 1_000, chain: false, status: 413 },
  { type: 7, operations: 87_380, children: 2, chain: false, duplicate: true, status: 200 },
  { type: 7, operations: 87_381, children: 2, chain: false, duplicate: true, status: 413 },
])("charges in-pack ancestor replays: type=$type operations=$operations children=$children chain=$chain duplicate=$duplicate", async ({ type, operations, children, chain, duplicate, status }) => {
  const bucket = new Bucket(), reserve = vi.fn(async () => status === 200);
  const data = Buffer.from("x"), ancestor = Buffer.alloc(operations, 97);
  const entries: Parameters<typeof pushBody>[0] = [{ data }, {
    type: 7, base: Buffer.from(blobOid(data), "hex"), data: literalDelta(operations),
  }];
  const entryLength = (entry: typeof entries[number]) => packEntryHeader(entry.type ?? 3, entry.data.length).length
    + (entry.base?.length ?? 0) + deflateSync(entry.data).length;
  let distance = entryLength(entries[1]), base = ancestor, target = ancestor;
  // A cheap encoding can expose the OID before a more expensive encoding resolves.
  if (duplicate) entries.unshift({ data: ancestor });
  for (let i = 0; i < children; i++) {
    const offset = [distance & 127];
    for (let remaining = Math.floor(distance / 128); remaining; remaining = Math.floor(remaining / 128)) {
      remaining--; offset.unshift(128 | (remaining & 127));
    }
    target = Buffer.from([98, i % 256]);
    const entry = { type, base: type === 7 ? Buffer.from(blobOid(base), "hex") : Buffer.from(offset),
      data: Buffer.concat([unsigned(base.length), unsigned(target.length), Buffer.from([1, target[0], 1, target[1]])]) };
    entries.push(entry);
    distance = (chain ? 0 : distance) + entryLength(entry);
    if (chain) base = target;
  }
  // Stop before indexing on a regression, so the large fan-out cannot replay hundreds of millions of commands.
  const response = await receive(bucket, pushBody(entries, blobOid(target)), reserve);
  expect(response.status).toBe(status);
  if (status === 413) {
    expect(await response.text()).toContain("delta operation budget");
    expect(reserve).not.toHaveBeenCalled();
    expect([...bucket.objects.keys()].some((key) => key.endsWith(".pack"))).toBe(false);
  } else {
    expect(await response.text()).toContain(`ok refs/tags/test-${blobOid(target)}`);
    expect(reserve).toHaveBeenCalledOnce();
  }
});

it.each([6, 7])("rejects oversized delta output for pack type %s", async (type) => {
  const data = Buffer.from("a"), header = packEntryHeader(3, data.length), compressed = deflateSync(data);
  const base = type === 7 ? Buffer.from(blobOid(data), "hex") : Buffer.from([header.length + compressed.length]);
  const delta = Buffer.concat([unsigned(1), unsigned(24 * 1024 * 1024), Buffer.from([1, 97])]);
  expect((await receive(new Bucket(), pushBody([{ data }, { type, base, data: delta }]))).status).toBe(413);
});

it.each([3, 6, 7])("validates an OFS_DELTA source against a preceding type %s result", async (type) => {
  const bucket = new Bucket(), reserve = vi.fn(async () => true), data = Buffer.alloc(0);
  const entries: Parameters<typeof pushBody>[0] = [{ data }];
  if (type !== 3) entries.push({ type, data: Buffer.from([0, 2, 2, 97, 98]),
    base: type === 7 ? Buffer.from(blobOid(data), "hex") : Buffer.from([packEntryHeader(3, 0).length + deflateSync(data).length]) });
  const preceding = entries.at(-1)!;
  const distance = packEntryHeader(type, preceding.data.length).length + (preceding.base?.length ?? 0) + deflateSync(preceding.data).length;
  const target = blobOid(Buffer.from("abc"));
  const body = (source: number) => pushBody([...entries, {
    type: 6, base: Buffer.from([distance]), data: Buffer.from([source, 3, 3, 97, 98, 99]),
  }], target);
  const invalid = await receive(bucket, body(type === 3 ? 1 : 5), reserve);
  expect(invalid.status).toBe(400);
  expect(reserve).not.toHaveBeenCalled();
  expect([...bucket.objects.keys()].some((key) => key.endsWith(".pack"))).toBe(false);
  const valid = await receive(bucket, body(type === 3 ? 0 : 2), reserve);
  expect(valid.status).toBe(200);
  expect(await valid.text()).toContain(`ok refs/tags/test-${target}`);
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

it.each([0, 4])("rejects conflicting declarations for a repeated %s-byte stored delta base", async (size) => {
  const bucket = new Bucket(), reserve = vi.fn(async () => true), data = Buffer.alloc(size, 97);
  expect(await (await receive(bucket, pushBody([{ data }], blobOid(data)))).text()).toContain("unpack ok");
  const stored = [...bucket.objects.keys()];
  const body = pushBody([size === 0 ? 1 : 0, size].map((source, i) => ({
    type: 7, base: Buffer.from(blobOid(data), "hex"), data: Buffer.from([source, 1, 1, 97 + i]),
  })), blobOid(Buffer.from("b")));
  const response = await receive(bucket, body, reserve);
  expect(response.status).toBe(400);
  expect(await response.text()).toBe("Invalid Git pack");
  expect(reserve).not.toHaveBeenCalled();
  expect([...bucket.objects.keys()]).toEqual(stored);
});

it.each([0, 4])("accepts matching declarations for a repeated %s-byte stored delta base", async (size) => {
  const bucket = new Bucket(), reserve = vi.fn(async () => true), data = Buffer.alloc(size, 97);
  expect(await (await receive(bucket, pushBody([{ data }], blobOid(data)))).text()).toContain("unpack ok");
  const target = blobOid(Buffer.from("b"));
  const body = pushBody([97, 98].map((value) => ({
    type: 7, base: Buffer.from(blobOid(data), "hex"), data: Buffer.from([size, 1, 1, value]),
  })), target);
  const response = await receive(bucket, body, reserve);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain(`ok refs/tags/test-${target}`);
  expect(reserve).toHaveBeenCalledOnce();
});

async function storeFragmentedHistory(bucket: Bucket) {
  for (let i = 0; i < 128; i++) {
    const data = Buffer.from(`stored blob ${i}`);
    const pack = createGitPack([{ oid: blobOid(data), entry: { type: 3, size: data.length, data: deflateSync(data) } }], { index: true });
    const path = `git/repos/${repoId}/repo.git/objects/pack/pack-${pack.checksum}`;
    await bucket.put(`${path}.pack`, new Uint8Array(await new Response(pack.stream()).arrayBuffer()));
    await bucket.put(`${path}.idx`, pack.index!);
  }
}

it("accepts in-pack bases without spending the stored-base lookup budget", async () => {
  const bucket = new Bucket(), reserve = vi.fn(async () => true);
  await storeFragmentedHistory(bucket);
  const contents = Array.from({ length: 512 }, (_, i) => Buffer.from(`incoming blob ${i}`));
  const deltas = contents.map((data) => ({
    type: 7, base: Buffer.from(blobOid(data), "hex"), data: Buffer.from([data.length, data.length + 1, 0x90, data.length, 1, 33]),
  }));
  const target = blobOid(Buffer.concat([contents.at(-1)!, Buffer.from("!")]));
  const response = await receive(bucket, pushBody([...contents.map((data) => ({ data })), ...deltas], target), reserve);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain(`ok refs/tags/test-${target}`);
  expect(reserve).toHaveBeenCalledOnce();
  expect([...bucket.objects.keys()].filter((key) => key.endsWith(".pack"))).toHaveLength(129);
});

it.each([0, 4])("rejects an incorrect source size for a %s-byte in-pack base", async (size) => {
  const bucket = new Bucket(), reserve = vi.fn(async () => true), data = Buffer.alloc(size, 97);
  const body = pushBody([{
    type: 7, base: Buffer.from(blobOid(data), "hex"), data: Buffer.from([size === 0 ? 1 : 0, 1, 1, 97]),
  }, { data }], blobOid(Buffer.from("a")));
  const response = await receive(bucket, body, reserve);
  expect(response.status).toBe(400);
  expect(reserve).not.toHaveBeenCalled();
  expect([...bucket.objects.keys()].some((key) => key.endsWith(".pack"))).toBe(false);
});

it.each([{ type: 1, name: "commit" }, { type: 2, name: "tree" }, { type: 3, name: "blob" }, { type: 4, name: "tag" }])(
  "resolves an in-pack $name base without a stored lookup", async ({ type, name }) => {
    const data = Buffer.alloc(0), oid = createHash("sha1").update(`${name} 0\0`).digest();
    const body = pushBody([{ type: 7, base: oid, data: Buffer.from([0, 0]) }, { type, data }]);
    const reader = { size: vi.fn(async () => null) };
    await validateGitPack(body.subarray(body.indexOf("PACK")), 16 * 1024 * 1024, reader as never);
    expect(reader.size).not.toHaveBeenCalled();
  });

it("bounds thin-base lookups across cached pack indexes before reserving or storing the pack", async () => {
  const bucket = new Bucket(), reserve = vi.fn(async () => true);
  await storeFragmentedHistory(bucket);
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

it.each([{ depth: 1, size: 24 * 1024 * 1024 }, { depth: 2, size: 24 * 1024 * 1024 }, { depth: 2, size: 4 }])(
  "validates a $size-byte stored delta ancestor at depth $depth", async ({ depth, size }) => {
    const bucket = new Bucket(), reserve = vi.fn(async () => true), legacy = Buffer.alloc(size, 97);
    const contents = [legacy, Buffer.from("a"), Buffer.from("ab")].slice(0, depth + 1);
    const pack = createGitPack(contents.map((content, i) => {
      const data = i === 0 ? content : Buffer.concat([
        unsigned(contents[i - 1].length), unsigned(content.length), Buffer.from([content.length]), content,
      ]);
      return { oid: blobOid(content), entry: { type: i === 0 ? 3 : 7, size: data.length,
        base: i === 0 ? undefined : blobOid(contents[i - 1]), data: deflateSync(data) } };
    }), { index: true });
    const path = `git/repos/${repoId}/repo.git/objects/pack/pack-${pack.checksum}`;
    await bucket.put(`${path}.pack`, new Uint8Array(await new Response(pack.stream()).arrayBuffer()));
    await bucket.put(`${path}.idx`, pack.index!);
    const base = contents.at(-1)!;
    const response = await receive(bucket, pushBody([{
      type: 7, base: Buffer.from(blobOid(base), "hex"), data: Buffer.from([base.length, 3, 3, 97, 98, 99]),
    }], blobOid(Buffer.from("abc"))), reserve);
    if (size > 16 * 1024 * 1024) {
      expect(response.status).toBe(413);
      expect(reserve).not.toHaveBeenCalled();
      expect([...bucket.objects.keys()].filter((key) => key.endsWith(".pack"))).toHaveLength(1);
    } else {
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(`ok refs/tags/test-${blobOid(Buffer.from("abc"))}`);
      expect(reserve).toHaveBeenCalledOnce();
    }
  });

it("rejects an unresolved REF_DELTA before reserving or storing the pack", async () => {
  const bucket = new Bucket(), reserve = vi.fn(async () => true);
  const response = await receive(bucket, pushBody([{
    type: 7, base: Buffer.alloc(20, 1), data: Buffer.from([0, 1, 1, 97]),
  }], blobOid(Buffer.from("a"))), reserve);
  expect(response.status).toBe(400);
  expect(reserve).not.toHaveBeenCalled();
  expect([...bucket.objects.keys()].some((key) => key.endsWith(".pack"))).toBe(false);
});

it.each([6, 7])("resolves REF_DELTA bases produced by an in-pack type %s delta", async (type) => {
  const data = Buffer.from("a"), middle = Buffer.from("ab"), target = Buffer.from("abc");
  const entries = [{ data }, { type,
    base: type === 7 ? Buffer.from(blobOid(data), "hex") : Buffer.from([packEntryHeader(3, 1).length + deflateSync(data).length]),
    data: Buffer.from([1, 2, 0x90, 1, 1, 98]),
  }, { type: 7, base: Buffer.from(blobOid(middle), "hex"), data: Buffer.from([2, 3, 0x90, 2, 1, 99]) }];
  const response = await receive(new Bucket(), pushBody(entries, blobOid(target)));
  expect(response.status).toBe(200);
  expect(await response.text()).toContain(`ok refs/tags/test-${blobOid(target)}`);
  // Resolve local delta chains before consulting storage, regardless of REF_DELTA order.
  if (type === 7) entries.reverse();
  const body = pushBody(entries), reader = { size: vi.fn(async () => null), info: vi.fn(async () => null) };
  await validateGitPack(body.subarray(body.indexOf("PACK")), 16 * 1024 * 1024, reader as never);
  expect(reader.size).not.toHaveBeenCalled();
  expect(reader.info).not.toHaveBeenCalled();
});

it.each([false, true])("resolves an incoming delta chain rooted in stored history (loose=%s)", async (loose) => {
  const bucket = new Bucket(), data = Buffer.from("a"), target = Buffer.from("abc");
  if (loose) {
    const oid = blobOid(data);
    await bucket.put(`git/repos/${repoId}/repo.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`,
      deflateSync(Buffer.concat([Buffer.from("blob 1\0"), data])));
  } else {
    expect((await receive(bucket, pushBody([{ data }], blobOid(data)))).status).toBe(200);
  }
  const entries = [
    { type: 7, base: Buffer.from(blobOid(data), "hex"), data: Buffer.from([1, 2, 0x90, 1, 1, 98]) },
    { type: 7, base: Buffer.from(blobOid(Buffer.from("ab")), "hex"), data: Buffer.from([2, 3, 0x90, 2, 1, 99]) },
  ];
  const reader = new GitObjectReader(readGitRepository(bucket as never, repoId)), info = vi.spyOn(reader, "info");
  // The first missing base can become available after a later thin base resolves.
  const body = pushBody([...entries].reverse());
  await validateGitPack(body.subarray(body.indexOf("PACK")), 16 * 1024 * 1024, reader);
  expect(info).toHaveBeenCalledTimes(2);
  const response = await receive(bucket, pushBody(entries, blobOid(target)));
  expect(response.status).toBe(200);
  expect(await response.text()).toContain(`ok refs/tags/test-${blobOid(target)}`);
});

it("rejects an incorrect source size for a base produced by another delta", async () => {
  const bucket = new Bucket(), reserve = vi.fn(async () => true), data = Buffer.from("a");
  const body = pushBody([{ data }, {
    type: 7, base: Buffer.from(blobOid(data), "hex"), data: Buffer.from([1, 2, 2, 97, 98]),
  }, { type: 7, base: Buffer.from(blobOid(Buffer.from("ab")), "hex"), data: Buffer.from([1, 1, 1, 99]) }]);
  expect((await receive(bucket, body, reserve)).status).toBe(400);
  expect(reserve).not.toHaveBeenCalled();
  expect([...bucket.objects.keys()].some((key) => key.endsWith(".pack"))).toBe(false);
});

it.each([
  { stored: 262_145, incoming: 1, depth: 1, status: 413 },
  { stored: 262_145, incoming: 1, depth: 2, status: 413 },
  { stored: 131_072, incoming: 131_073, depth: 1, status: 413 },
  { stored: 262_143, incoming: 1, depth: 1, status: 200 },
  { stored: 131_071, incoming: 1, depth: 1, copies: 2, status: 200 },
  { stored: 131_072, incoming: 1, depth: 1, copies: 2, status: 413 },
])("shares the delta budget with $stored stored operations at depth $depth and $incoming incoming operations (copies=$copies)", async ({ stored, incoming, depth, copies = 1, status }) => {
  const bucket = new Bucket(), reserve = vi.fn(async () => true);
  const contents = [Buffer.from("x"), Buffer.alloc(stored, 97), Buffer.from("ab")].slice(0, depth + 1);
  const pack = createGitPack(contents.map((content, i) => {
    const data = i === 0 ? content : i === 1 ? literalDelta(stored) : Buffer.concat([
      unsigned(contents[i - 1].length), unsigned(content.length), Buffer.from([content.length]), content,
    ]);
    return { oid: blobOid(content), entry: { type: i === 0 ? 3 : 7, size: data.length,
      base: i === 0 ? undefined : blobOid(contents[i - 1]), data: deflateSync(data) } };
  }), { index: true });
  const path = `git/repos/${repoId}/repo.git/objects/pack/pack-${pack.checksum}`;
  await bucket.put(`${path}.pack`, new Uint8Array(await new Response(pack.stream()).arrayBuffer()));
  await bucket.put(`${path}.idx`, pack.index!);
  const target = blobOid(Buffer.alloc(incoming, 97 + copies - 1));
  const response = await receive(bucket, pushBody(Array.from({ length: copies }, (_, i) => ({
    type: 7, base: Buffer.from(blobOid(contents.at(-1)!), "hex"), data: Buffer.concat([
      unsigned(contents.at(-1)!.length), unsigned(incoming), Buffer.alloc(incoming * 2).fill(Buffer.from([1, 97 + i])),
    ]),
  })), target), reserve);
  expect(response.status).toBe(status);
  if (status === 413) {
    expect(await response.text()).toContain("delta operation budget");
    expect(reserve).not.toHaveBeenCalled();
    expect([...bucket.objects.keys()].filter((key) => key.endsWith(".pack"))).toHaveLength(1);
  } else {
    expect(await response.text()).toContain(`ok refs/tags/test-${target}`);
    expect(reserve).toHaveBeenCalledOnce();
  }
});

it.each([{ operations: 131_070, status: 200 }, { operations: 131_071, status: 413 }])(
  "charges $operations cached ancestor operations for each stored base", async ({ operations, status }) => {
    const bucket = new Bucket(), reserve = vi.fn(async () => true);
    const contents = [Buffer.from("x"), Buffer.alloc(operations, 97), Buffer.from("ab"), Buffer.from("ac")];
    const pack = createGitPack(contents.map((content, i) => {
      const data = i === 0 ? content : i === 1 ? literalDelta(operations) : Buffer.concat([
        unsigned(operations), unsigned(content.length), Buffer.from([content.length]), content,
      ]);
      return { oid: blobOid(content), entry: { type: i === 0 ? 3 : 7, size: data.length,
        base: i === 0 ? undefined : blobOid(contents[i === 1 ? 0 : 1]), data: deflateSync(data) } };
    }), { index: true });
    const path = `git/repos/${repoId}/repo.git/objects/pack/pack-${pack.checksum}`;
    await bucket.put(`${path}.pack`, new Uint8Array(await new Response(pack.stream()).arrayBuffer()));
    await bucket.put(`${path}.idx`, pack.index!);
    const target = blobOid(Buffer.from("ac!"));
    const response = await receive(bucket, pushBody(contents.slice(2).map((data) => ({
      type: 7, base: Buffer.from(blobOid(data), "hex"),
      data: Buffer.concat([Buffer.from([2, 3, 3]), data, Buffer.from("!")]),
    })), target), reserve);
    expect(response.status).toBe(status);
    if (status === 413) {
      expect(await response.text()).toContain("delta operation budget");
      expect(reserve).not.toHaveBeenCalled();
      expect([...bucket.objects.keys()].filter((key) => key.endsWith(".pack"))).toHaveLength(1);
    } else {
      expect(await response.text()).toContain(`ok refs/tags/test-${target}`);
      expect(reserve).toHaveBeenCalledOnce();
    }
  });

it.each([false, true])("preserves storage failures while inspecting a thin pack base (packed=%s)", async (packed) => {
  const bucket = new Bucket(), data = Buffer.from("x"), oid = blobOid(data);
  if (packed) await receive(bucket, pushBody([{ data }], oid));
  else await bucket.put(`git/repos/${repoId}/repo.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`,
    deflateSync(Buffer.concat([Buffer.from(`blob ${data.length}\0`), data])));
  const get = bucket.get.bind(bucket);
  vi.spyOn(bucket, "get").mockImplementation(async (key) => {
    if (key.includes("/objects/")) throw new Error("storage unavailable");
    return get(key);
  });
  const delta = Buffer.from([1, 1, 1, 97]);
  await expect(receive(bucket, pushBody([{ data: delta, type: 7, base: Buffer.from(oid, "hex") }])))
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
    await git(root, "push", "origin", "main:refs/heads/作業");
    expect((await git(root, "ls-remote", "--heads", "origin")).stdout).toContain("refs/heads/作業");
    await git(root, "push", "origin", "--delete", "作業");
    expect((await git(root, "ls-remote", "--heads", "origin")).stdout).not.toContain("refs/heads/作業");
    await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "tag.gpgSign=false", "tag", "-a", "v1", "-m", "release");
    await git(root, "push", "origin", "refs/tags/v1");
    const commitOid = (await git(root, "rev-parse", "main")).stdout.trim();
    expect((await git(root, "ls-remote", "--tags", "origin")).stdout).toContain(`${commitOid}\trefs/tags/v1^{}`);
    writeFileSync(join(copy, "from-copy.txt"), "copy"); await git(copy, "add", "from-copy.txt"); await commit(copy);
    writeFileSync(join(root, "from-original.txt"), "original"); await git(root, "add", "from-original.txt"); await commit(root);
    await git(root, "push", "origin", "main"); await expect(git(copy, "push", "origin", "main")).rejects.toThrow();
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (!root.startsWith(tmpdir() + sep)) throw new Error("Git fixture escaped the temporary directory");
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
