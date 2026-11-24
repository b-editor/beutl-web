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
import { getDb } from "@beutl/db";
import { withGitDatabase } from "../packages/api/src/git/accounting";
import { GitRepositoryDurableObject } from "../packages/api/src/git/repo-durable-object";
import { advertiseGitRefs, MAX_GIT_REPOSITORY_BYTES, readGitRepository, receiveGitPack, uploadGitPack } from "../packages/api/src/git/git-http";
import { createGitPack, gitIndexBytes, packEntryHeader } from "../packages/api/src/git/pack-writer";
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
function refCommands(updates: [string, string, string][], capabilities = "report-status") {
  const packets = updates.map(([ref, before, after], i) => {
    const line = `${before} ${after} ${ref}${i === 0 ? `\0${capabilities}` : ""}\n`;
    return `${(Buffer.byteLength(line) + 4).toString(16).padStart(4, "0")}${line}`;
  });
  return Buffer.from(packets.join("") + "0000");
}
function refCommand(ref: string, before: string, after: string, capabilities?: string) {
  return refCommands([[ref, before, after]], capabilities);
}
function packedObject(type: "commit" | "tree" | "blob" | "tag", data: Uint8Array) {
  return { type: { commit: 1, tree: 2, blob: 3, tag: 4 }[type], data,
    oid: createHash("sha1").update(`${type} ${data.length}\0`).update(data).digest("hex") };
}
function commitObject(tree: string, parent?: string) {
  return packedObject("commit", Buffer.from(`tree ${tree}\n${parent ? `parent ${parent}\n` : ""}`
    + "author Test <test@example.com> 1 +0000\ncommitter Test <test@example.com> 1 +0000\n\nCommit\n"));
}
function treeEntry(mode: string, name: string, oid: string) {
  return Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, "hex")]);
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
it("checks the existence and type of existing ref tips used as new branch targets", async () => {
  const bucket = new Bucket(), data = Buffer.from("a tagged blob"), oid = blobOid(data);
  expect(await (await receive(bucket, pushBody([{ data }], oid))).text()).toContain("ok refs/tags/");
  const branch = refCommand("refs/heads/main", "0".repeat(40), oid);
  expect(await (await receive(bucket, branch)).text()).toContain("ng refs/heads/main invalid target object");
  await bucket.delete([...bucket.objects.keys()].filter((key) => /\.(pack|idx)$/u.test(key)));
  const tag = refCommand("refs/tags/new", "0".repeat(40), oid);
  expect(await (await receive(bucket, tag)).text()).toContain("ng refs/tags/new invalid target object");
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
it.each([false, true])("skips old commits and unchanged subtrees of a packed 1,000-commit history (changed tree=%s)", async (changed) => {
  const bucket = new Bucket(), blob = packedObject("blob", Buffer.from("initial content"));
  const unchanged = packedObject("tree", treeEntry("100644", "kept.txt", blob.oid));
  const directory = packedObject("tree", Buffer.concat([
    treeEntry("100644", "edit.txt", blob.oid), treeEntry("40000", "kept", unchanged.oid),
  ]));
  const tree = packedObject("tree", treeEntry("40000", "dir", directory.oid));
  const history = [blob, unchanged, directory, tree];
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
  const edit = packedObject("blob", Buffer.from("edited content"));
  const nextDirectory = packedObject("tree", Buffer.concat([
    treeEntry("100644", "edit.txt", edit.oid), treeEntry("40000", "kept", unchanged.oid),
  ]));
  const nextTree = packedObject("tree", treeEntry("40000", "dir", nextDirectory.oid));
  const next = commitObject(changed ? nextTree.oid : tree.oid, parent);
  const packed = pushBody(changed ? [next, nextTree, nextDirectory, edit] : [next], next.oid);
  const body = Buffer.concat([refCommand("refs/heads/main", parent!, next.oid), packed.subarray(packed.indexOf("PACK"))]);
  const get = vi.spyOn(bucket, "get"), info = vi.spyOn(GitObjectReader.prototype, "info"), read = vi.spyOn(GitObjectReader.prototype, "read");
  try {
    expect(await (await receive(bucket, body)).text()).toContain("ok refs/heads/main");
    const compared = changed ? [parent, tree.oid, directory.oid] : [parent];
    expect(info.mock.calls.map(([oid]) => oid)).toEqual(compared);
    expect(read.mock.calls.map(([oid]) => oid)).toEqual(compared);
    expect(get.mock.calls.map(([key]) => key).filter((key) => key.includes("/objects/")))
      .toEqual([`${path}.idx`, `${path}.pack`]);
  } finally { info.mockRestore(); read.mockRestore(); }
});
it("validates an unreachable stored tree when a gitlink becomes a directory", async () => {
  const bucket = new Bucket(), reserve = vi.fn(async () => true);
  const broken = packedObject("tree", treeEntry("100644", "missing", "1".repeat(40)));
  const tree = packedObject("tree", treeEntry("160000", "dir", broken.oid));
  const parent = commitObject(tree.oid);
  const initialPack = pushBody([broken, tree, parent], parent.oid);
  expect(await (await receive(bucket, Buffer.concat([
    refCommand("refs/heads/main", "0".repeat(40), parent.oid), initialPack.subarray(initialPack.indexOf("PACK")),
  ]))).text()).toContain("ok refs/heads/main");
  const nextTree = packedObject("tree", treeEntry("40000", "dir", broken.oid)), next = commitObject(nextTree.oid, parent.oid);
  const pack = pushBody([nextTree, next], next.oid);
  const push = Buffer.concat([refCommand("refs/heads/main", parent.oid, next.oid), pack.subarray(pack.indexOf("PACK"))]);
  expect(await (await receive(bucket, push, reserve)).text()).toContain("ng refs/heads/main incomplete object graph");
  expect(reserve).not.toHaveBeenCalled();
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
it("updates a packed ref deletion from the pre-push snapshot without reading storage after the pack write", async () => {
  const bucket = new Bucket(), original = Buffer.from("original"), next = Buffer.from("new");
  const oid = blobOid(original), newOid = blobOid(next);
  await receive(bucket, pushBody([{ data: original }], oid));
  const packedKey = `git/repos/${repoId}/repo.git/packed-refs`;
  await bucket.put(packedKey, Buffer.from(`# pack-refs with: peeled\n${oid} refs/tags/kept\n${oid} refs/tags/old\n^${oid}\n`));
  const upload = pushBody([{ data: next }], newOid), packStart = upload.indexOf("PACK");
  const deletion = `${oid} ${"0".repeat(40)} refs/tags/old\n`;
  const body = Buffer.concat([upload.subarray(0, packStart - 4),
    Buffer.from(`${(Buffer.byteLength(deletion) + 4).toString(16).padStart(4, "0")}${deletion}0000`), upload.subarray(packStart)]);
  const get = vi.spyOn(bucket, "get"), put = vi.spyOn(bucket, "put");
  const status = await (await receive(bucket, body)).text();
  expect(status).toContain(`ok refs/tags/test-${newOid}`);
  expect(status).toContain("ok refs/tags/old");
  expect(Buffer.from(bucket.objects.get(packedKey)!).toString()).toBe(`# pack-refs with: peeled\n${oid} refs/tags/kept\n`);
  const packWrite = put.mock.calls.findIndex(([key]) => key.endsWith(".pack"));
  expect(get.mock.invocationCallOrder.every((call) => call < put.mock.invocationCallOrder[packWrite])).toBe(true);
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
it("accepts and indexes a forward REF_DELTA with the same v2 index as native Git", async () => {
  const bucket = new Bucket(), base = Buffer.from("a"), result = Buffer.from("ab"), oid = blobOid(result);
  const entries = [{ type: 7, base: Buffer.from(blobOid(base), "hex"), data: Buffer.from([1, 2, 0x90, 1, 1, 98]) }, { data: base }];
  const get = vi.spyOn(bucket, "get"), put = vi.spyOn(bucket, "put");
  expect(await (await receive(bucket, pushBody(entries, oid))).text()).toContain(`ok refs/tags/test-${oid}`);
  const packWrite = put.mock.calls.findIndex(([key]) => key.endsWith(".pack"));
  const [packKey] = put.mock.calls[packWrite], indexKey = packKey.replace(/\.pack$/u, ".idx");
  expect(put.mock.calls[packWrite + 1][0]).toBe(indexKey);
  expect(get.mock.calls).not.toContainEqual([packKey]);
  expect(get.mock.invocationCallOrder.every((call) => call < put.mock.invocationCallOrder[packWrite])).toBe(true);

  const pack = bucket.objects.get(packKey)!, index = bucket.objects.get(indexKey)!;
  expect(index.byteLength).toBe(gitIndexBytes(entries.length));
  const reader = new GitObjectReader(readGitRepository(bucket as never, repoId));
  expect(Buffer.from(await reader.read(oid))).toEqual(result);
  expect(Buffer.from(await reader.read(blobOid(base)))).toEqual(base);

  const root = mkdtempSync(join(tmpdir(), "beutl-git-index-"));
  const git = (...args: string[]) => execute("git", ["--git-dir", root, ...args]);
  try {
    await git("init", "--bare", "--object-format=sha1", "-q");
    const checksum = Buffer.from(pack.subarray(-20)).toString("hex");
    const path = join(root, "objects", "pack", `pack-${checksum}`);
    writeFileSync(`${path}.pack`, pack);
    writeFileSync(`${path}.idx`, index);
    writeFileSync(join(root, "refs", "tags", "test"), `${oid}\n`);
    await git("index-pack", "--index-version=2", "-o", join(root, "native.idx"), `${path}.pack`);
    expect(readFileSync(join(root, "native.idx"))).toEqual(Buffer.from(index));
    await git("verify-pack", `${path}.idx`);
    await git("fsck", "--strict");
    expect((await git("cat-file", "blob", oid)).stdout).toBe(result.toString());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.each([false, true])("indexes both entries for a duplicate OID (delta first=%s)", async (deltaFirst) => {
  const bucket = new Bucket(), data = Buffer.alloc(0), oid = blobOid(data);
  const delta = { type: 7, base: Buffer.from(oid, "hex"), data: Buffer.from([0, 0]) };
  expect(await (await receive(bucket, pushBody(deltaFirst ? [delta, { data }] : [{ data }, delta], oid))).text())
    .toContain(`ok refs/tags/test-${oid}`);
  const [indexKey, index] = [...bucket.objects].find(([key]) => key.endsWith(".idx"))!;
  const view = new DataView(index.buffer, index.byteOffset, index.byteLength);
  expect(view.getUint32(1028)).toBe(2);
  expect(index.byteLength).toBe(gitIndexBytes(2));
  expect(Buffer.from(index.subarray(1032, 1072)).toString("hex")).toBe(oid.repeat(2));
  expect(view.getUint32(1080)).toBe(12);
  const first = deltaFirst ? delta : { type: 3, data, base: undefined };
  expect(view.getUint32(1084)).toBe(12 + packEntryHeader(first.type, first.data.length).length
    + (first.base?.length ?? 0) + deflateSync(first.data).length);
  const reader = new GitObjectReader(readGitRepository(bucket as never, repoId));
  expect(await reader.read(oid)).toEqual(new Uint8Array());
  const entries = await reader.packEntries(indexKey.split("/").at(-1)!.replace(/\.idx$/u, ".pack"));
  expect(entries.get(oid)?.type).toBe(3);
});

it.each([false, true])("writes a thin pack without storage reads after PUT and can retry a failed index write (loose=%s)", async (loose) => {
  const bucket = new Bucket(), base = Buffer.from("a"), target = Buffer.from("ab"), baseOid = blobOid(base);
  if (loose) {
    const looseKey = `git/repos/${repoId}/repo.git/objects/${baseOid.slice(0, 2)}/${baseOid.slice(2)}`;
    await bucket.put(looseKey, deflateSync(Buffer.concat([Buffer.from("blob 1\0"), base])));
    await receive(bucket, refCommand("refs/tags/base", "0".repeat(40), baseOid));
  } else {
    const ancestor = Buffer.from("x");
    await receive(bucket, pushBody([{ data: ancestor }, {
      type: 7, base: Buffer.from(blobOid(ancestor), "hex"), data: Buffer.from([1, 1, 1, 97]),
    }], baseOid));
  }
  const before = new Map(bucket.objects), put = bucket.put.bind(bucket), failure = new Error("B2 index write failed");
  const body = pushBody([{ type: 7, base: Buffer.from(baseOid, "hex"), data: Buffer.from([1, 2, 0x90, 1, 1, 98]) }], blobOid(target));
  const read = vi.spyOn(bucket, "get"), remove = vi.spyOn(bucket, "delete");
  let failIndex = true;
  const write = vi.spyOn(bucket, "put").mockImplementation(async (key, bytes) => {
    await put(key, bytes);
    if (failIndex && key.endsWith(".idx")) throw failure;
  });
  const checkWrites = () => {
    const [[packKey], [indexKey]] = write.mock.calls;
    expect(packKey).toMatch(/\.pack$/u);
    expect(indexKey).toBe(packKey.replace(/\.pack$/u, ".idx"));
    expect(read.mock.calls).not.toContainEqual([packKey]);
    expect(read.mock.invocationCallOrder.every((call) => call < write.mock.invocationCallOrder[0])).toBe(true);
    return { packKey, indexKey };
  };
  await expect(receive(bucket, body)).rejects.toBe(failure);
  const { packKey, indexKey } = checkWrites();
  expect(remove.mock.calls).toEqual([[indexKey], [packKey]]);
  expect(bucket.objects).toEqual(before);
  const reader = new GitObjectReader(readGitRepository(bucket as never, repoId));
  expect(Buffer.from(await reader.read(baseOid))).toEqual(base);
  failIndex = false; read.mockClear(); write.mockClear();
  expect(await (await receive(bucket, body)).text()).toContain(`ok refs/tags/test-${blobOid(target)}`);
  checkWrites();
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
    delete: async (key: string) => values.delete(key),
    getAlarm: async () => null, setAlarm: async () => undefined };
}
function accountedRepository() {
  const bucket = new Bucket(), storage = memoryStorage();
  const accounting = {
    reserveHistory: vi.fn(async (_repoId: string, _ownerId: string, _bytes: number) => true),
    settleHistory: vi.fn(async (_repoId: string, _bytes: number) => undefined),
  };
  const durable = new GitRepositoryDurableObject({ storage: storage as never }, {}, bucket as never, accounting as never);
  const send = (path: string, body?: Uint8Array) => durable.fetch(new Request(
    `https://git.internal/api/v3/git/${repoId}.git/${path}`, {
      method: body === undefined ? "GET" : "POST", body,
      headers: { "x-beutl-repo-id": repoId, "x-beutl-git-scope": "write", "x-beutl-git-owner-id": "owner" },
    }));
  return { bucket, storage, accounting, send };
}
const gitBytes = (bucket: Bucket) => [...bucket.objects.values()].reduce((sum, value) => sum + value.byteLength, 0);

it.each([true, false])("shares a single repository listing between info/refs and a clean push (initialized=%s)", async (initialized) => {
  const { bucket, storage, accounting, send } = accountedRepository();
  const base = Buffer.from("base"), baseOid = blobOid(base);
  await receive(bucket, pushBody([{ data: base }], baseOid));
  await bucket.put(`git/repos/${repoId}/legacy-metadata`, Buffer.from("counted by history accounting"));
  if (initialized) storage.values.set("gitInitialized", true);
  const list = vi.spyOn(bucket, "list"), head = vi.spyOn(bucket, "head"), get = vi.spyOn(bucket, "get");
  const advert = await send("info/refs?service=git-upload-pack");
  expect(await advert.text()).toContain(`${baseOid} refs/tags/test-${baseOid}`);
  expect(list).toHaveBeenCalledTimes(1);
  expect(head).not.toHaveBeenCalled();
  expect(get.mock.calls.some(([key]) => key.endsWith("packed-refs"))).toBe(false);
  expect(storage.values.get("gitInitialized")).toBe(true);

  list.mockClear(); get.mockClear();
  accounting.reserveHistory.mockImplementationOnce(async () => {
    expect(accounting.settleHistory).not.toHaveBeenCalled();
    expect(storage.values.get("historyUnsettled")).toBe(true);
    return true;
  });
  // The thin pack uses the base index and pack read while advertising the tag.
  const nextOid = blobOid(Buffer.from("base!"));
  const reply = await send("git-receive-pack", pushBody([{
    data: Buffer.from([4, 5, 0x90, 4, 1, 33]), type: 7, base: Buffer.from(baseOid, "hex"),
  }], nextOid));
  expect(await reply.text()).toContain(`ok refs/tags/test-${nextOid}`);
  expect(list).not.toHaveBeenCalled();
  expect(head).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
  expect(accounting.reserveHistory).toHaveBeenCalledOnce();
  expect(accounting.settleHistory).toHaveBeenCalledExactlyOnceWith(repoId, gitBytes(bucket));
  expect(storage.values.has("historyUnsettled")).toBe(false);
});

it("skips accounting and maintenance for pushes that make no writes", async () => {
  const { bucket, storage, accounting, send } = accountedRepository();
  await advertiseGitRefs(bucket as never, repoId, "git-receive-pack");
  const put = vi.spyOn(bucket, "put");
  const rejected = await send("git-receive-pack", refCommand("refs/heads/main", "1".repeat(40), "0".repeat(40)));
  expect(await rejected.text()).toContain("ng refs/heads/main stale ref");
  expect((await send("git-receive-pack", Buffer.from("bad command"))).status).toBe(400);

  accounting.reserveHistory.mockResolvedValueOnce(false);
  const data = Buffer.from("over quota");
  expect((await send("git-receive-pack", pushBody([{ data }], blobOid(data)))).status).toBe(413);
  expect(put).not.toHaveBeenCalled();
  expect(accounting.reserveHistory).toHaveBeenCalledOnce();
  expect(accounting.settleHistory).not.toHaveBeenCalled();
  for (const key of ["lastPushFinishedAt", "gitGcPending", "historyUnsettled"]) expect(storage.values.has(key)).toBe(false);
});

it("reconciles a failed push before the next reservation when its immediate recount fails", async () => {
  const { bucket, storage, accounting, send } = accountedRepository();
  await send("info/refs?service=git-receive-pack");
  accounting.reserveHistory.mockClear();
  accounting.settleHistory.mockClear();
  const data = Buffer.from("first push"), oid = blobOid(data), body = pushBody([{ data }], oid);
  const list = vi.spyOn(bucket, "list"), put = bucket.put.bind(bucket);
  const failure = vi.spyOn(bucket, "put").mockImplementation(async (key, bytes) => {
    if (key.endsWith(`/refs/tags/test-${oid}`)) {
      list.mockRejectedValueOnce(new Error("B2 recount unavailable"));
      throw new Error("B2 ref write failed");
    }
    await put(key, bytes);
  });
  await expect(send("git-receive-pack", body)).rejects.toThrow("B2 recount unavailable");
  expect(accounting.reserveHistory).toHaveBeenCalledOnce();
  expect(accounting.settleHistory).not.toHaveBeenCalled();
  expect(storage.values.get("historyUnsettled")).toBe(true);
  const afterFailure = gitBytes(bucket);

  failure.mockRestore();
  list.mockClear();
  accounting.reserveHistory.mockImplementationOnce(async () => {
    expect(accounting.settleHistory).toHaveBeenCalledExactlyOnceWith(repoId, afterFailure);
    return true;
  });
  expect(await (await send("git-receive-pack", body)).text()).toContain(`ok refs/tags/test-${oid}`);
  expect(list).toHaveBeenCalledOnce();
  expect(accounting.settleHistory.mock.calls).toEqual([[repoId, afterFailure], [repoId, gitBytes(bucket)]]);
  expect(storage.values.has("historyUnsettled")).toBe(false);
});

it("retries a reservation after reconciling a legacy outstanding DB reservation", async () => {
  const { bucket, storage, accounting, send } = accountedRepository();
  await advertiseGitRefs(bucket as never, repoId, "git-receive-pack");
  const before = gitBytes(bucket), list = vi.spyOn(bucket, "list");
  accounting.reserveHistory.mockRejectedValueOnce(new Error("Git history requires reconciliation"));
  accounting.reserveHistory.mockImplementationOnce(async () => {
    expect(accounting.settleHistory).toHaveBeenCalledExactlyOnceWith(repoId, before);
    expect(storage.values.get("historyUnsettled")).toBe(true);
    return true;
  });
  const data = Buffer.from("after reconciliation"), oid = blobOid(data);
  expect(await (await send("git-receive-pack", pushBody([{ data }], oid))).text()).toContain(`ok refs/tags/test-${oid}`);
  expect(accounting.reserveHistory).toHaveBeenCalledTimes(2);
  expect(accounting.settleHistory.mock.calls).toEqual([[repoId, before], [repoId, gitBytes(bucket)]]);
  expect(list).toHaveBeenCalledOnce();
  expect(storage.values.has("historyUnsettled")).toBe(false);
});

it("updates and deletes loose refs in parallel, rewriting packed-refs once without a new reservation", async () => {
  const bucket = new Bucket(), root = `git/repos/${repoId}/repo.git/`;
  const first = Buffer.from("first"), second = Buffer.from("second");
  const oldOid = blobOid(first), newOid = blobOid(second), zero = "0".repeat(40);
  await receive(bucket, pushBody([{ data: first }, { data: second }], oldOid));
  const moved = ["refs/tags/move-a", "refs/tags/move-b"], loose = ["refs/tags/drop-a", "refs/tags/drop-b"];
  for (const name of [...moved, ...loose]) await bucket.put(root + name, Buffer.from(`${oldOid}\n\n`));
  const removed = [...loose, "refs/tags/packed-only"];
  const retained = `# pack-refs with: peeled\n${oldOid} refs/tags/keep\n`;
  await bucket.put(root + "packed-refs", Buffer.from(retained + removed.map((name) => `${oldOid} ${name}\n^${oldOid}\n`).join("")));
  const deletesDone = Promise.withResolvers<void>(), putsDone = Promise.withResolvers<void>();
  const del = bucket.delete.bind(bucket), put = bucket.put.bind(bucket);
  const remove = vi.spyOn(bucket, "delete").mockImplementation(async (key) => { await deletesDone.promise; await del(key); });
  const write = vi.spyOn(bucket, "put").mockImplementation(async (key, value) => {
    if (key.includes("/refs/")) await putsDone.promise;
    await put(key, value);
  });
  const reserve = vi.fn(async () => true), beforeWrite = vi.fn(async () => undefined), onSettled = vi.fn();
  const body = refCommands([
    ...moved.map((key): [string, string, string] => [key, oldOid, newOid]),
    ...removed.map((key): [string, string, string] => [key, oldOid, zero]),
  ]);
  const pending = receiveGitPack(new Request("https://git.example.test/git-receive-pack", { method: "POST", body }),
    bucket as never, repoId, reserve, { beforeWrite, onSettled });
  try {
    await vi.waitFor(() => expect(remove.mock.calls).toEqual(loose.map((name) => [root + name])));
    deletesDone.resolve();
    await vi.waitFor(() => expect(write.mock.calls.map(([key]) => key)).toEqual([root + "packed-refs", ...moved.map((name) => root + name)]));
  } finally { deletesDone.resolve(); putsDone.resolve(); }
  const response = await (await pending).text();
  for (const name of [...moved, ...removed]) expect(response).toContain(`ok ${name}`);
  for (const name of moved) expect(Buffer.from(bucket.objects.get(root + name)!).toString()).toBe(`${newOid}\n`);
  for (const name of loose) expect(bucket.objects.has(root + name)).toBe(false);
  expect(Buffer.from(bucket.objects.get(root + "packed-refs")!).toString()).toBe(retained);
  expect(reserve).not.toHaveBeenCalled();
  expect(beforeWrite).toHaveBeenCalledOnce();
  expect(onSettled).toHaveBeenCalledExactlyOnceWith({ wrote: true, bytes: gitBytes(bucket) });
});

it("schedules lazy Git DB disconnection without blocking the response", async () => {
  const disconnected = Promise.withResolvers<void>();
  const disconnect = vi.fn(() => disconnected.promise);
  const connect = vi.fn(async () => ({ $disconnect: disconnect }) as never);
  const waitUntil = vi.fn((_work: Promise<unknown>) => undefined);
  expect(await withGitDatabase({}, async () => "no DB", connect, waitUntil)).toBe("no DB");
  expect(connect).not.toHaveBeenCalled();
  expect(waitUntil).not.toHaveBeenCalled();
  try {
    const result = await withGitDatabase({}, async () => { await getDb(); return "response"; }, connect, waitUntil);
    expect(result).toBe("response");
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  } finally { disconnected.resolve(); }
  await waitUntil.mock.calls[0][0];
});

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
  const list = vi.spyOn(bucket, "list");
  const accounting = { reserveHistory: vi.fn(async () => true), settleHistory: vi.fn(async () => undefined) };
  const durable = new GitRepositoryDurableObject({ storage: memoryStorage() as never }, {}, bucket as never, accounting as never);
  const advertise = (query: string, scope: string) => durable.fetch(new Request(
    `https://git.internal/api/v3/git/${repoId}.git/info/refs${query}`,
    { headers: { "x-beutl-repo-id": repoId, "x-beutl-git-scope": scope, "x-beutl-git-owner-id": "owner" } }));
  expect((await advertise("?service=git-unknown", "write")).status).toBe(400);
  expect((await advertise("", "write")).status).toBe(400);
  expect((await advertise("?service=git-receive-pack", "read")).status).toBe(403);
  expect(accounting.reserveHistory).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
  expect(bucket.objects.size).toBe(0);
  // A valid advertisement reserves the initialization before writing HEAD/config.
  expect((await advertise("?service=git-upload-pack", "read")).status).toBe(200);
  expect(accounting.reserveHistory).toHaveBeenCalledWith(repoId, "owner", 4096);
  expect(list).toHaveBeenCalledOnce();
  expect(accounting.settleHistory).toHaveBeenCalledExactlyOnceWith(repoId, gitBytes(bucket));
  expect(bucket.objects.size).toBeGreaterThan(0);
});
it("repairs partial initialization and retries unsettled accounting before marking the repository ready", async () => {
  const { bucket, storage, accounting, send } = accountedRepository();
  const head = `git/repos/${repoId}/repo.git/HEAD`, put = bucket.put.bind(bucket);
  const write = vi.spyOn(bucket, "put").mockImplementation(async (key, bytes) => {
    if (key === head) throw new Error("HEAD write failed");
    await put(key, bytes);
  });
  const advertise = () => send("info/refs?service=git-receive-pack");
  await expect(advertise()).rejects.toThrow("HEAD write failed");
  const partial = gitBytes(bucket);
  expect(partial).toBeGreaterThan(0);
  expect(storage.values.has("gitInitialized")).toBe(false);

  write.mockRestore();
  const repaired = vi.spyOn(bucket, "put");
  expect((await advertise()).status).toBe(200);
  expect(repaired).toHaveBeenCalledExactlyOnceWith(head, Buffer.from("ref: refs/heads/main\n"));
  expect(accounting.reserveHistory).toHaveBeenCalledExactlyOnceWith(repoId, "owner", 4096);
  expect(accounting.settleHistory.mock.calls).toEqual([[repoId, partial], [repoId, gitBytes(bucket)]]);
  expect(storage.values.get("gitInitialized")).toBe(true);

  // If both HEAD and config succeed but settleHistory fails, the next advertisement settles without rewriting either file.
  const retry = accountedRepository();
  retry.accounting.settleHistory.mockRejectedValueOnce(new Error("DB unavailable"));
  await expect(retry.send("info/refs?service=git-upload-pack")).rejects.toThrow("DB unavailable");
  expect(retry.storage.values.has("gitInitialized")).toBe(false);
  expect(retry.storage.values.get("historyUnsettled")).toBe(true);
  const retryPut = vi.spyOn(retry.bucket, "put");
  expect((await retry.send("info/refs?service=git-upload-pack")).status).toBe(200);
  expect(retryPut).not.toHaveBeenCalled();
  expect(retry.accounting.reserveHistory).toHaveBeenCalledOnce();
  expect(retry.accounting.settleHistory).toHaveBeenCalledTimes(2);
  expect(retry.accounting.settleHistory).toHaveBeenLastCalledWith(repoId, gitBytes(retry.bucket));
  expect(retry.storage.values.get("gitInitialized")).toBe(true);
  expect(retry.storage.values.has("historyUnsettled")).toBe(false);
});
it("counts packed refs toward the 128-ref limit while allowing updates to existing packed-only refs", async () => {
  const bucket = new Bucket(), root = `git/repos/${repoId}/repo.git/`;
  const first = Buffer.from("one"), second = Buffer.from("two");
  const firstOid = blobOid(first), secondOid = blobOid(second);
  expect(await (await receive(bucket, pushBody([{ data: first }, { data: second }], firstOid))).text()).toContain("ok ");
  await bucket.delete(`${root}refs/tags/test-${firstOid}`);
  await bucket.put(`${root}packed-refs`, Buffer.from(`${firstOid} refs/tags/packed-0\n`));
  for (let i = 1; i < 128; i++) {
    await bucket.put(`${root}refs/tags/loose-${i}`, Buffer.from(`${firstOid}\n`));
  }
  // 127 loose refs + 1 packed-only ref = 128 total: creating a 129th ref must fail with 413.
  const created = await receive(bucket, refCommand("refs/tags/overflow", "0".repeat(40), firstOid));
  expect(created.status).toBe(413);
  // Updating the existing packed-only ref does not increase the ref count and must succeed.
  const updated = await receive(bucket, refCommand("refs/tags/packed-0", firstOid, secondOid));
  expect(updated.status).toBe(200);
  expect(await updated.text()).toContain("ok refs/tags/packed-0");
});
it.each([false, true])("reads and rewrites a pack whose OFS_DELTA targets the second representation of a duplicate OID (deltaOnly=%s)", async (deltaOnly) => {
  const bucket = new Bucket();
  const baseData = Buffer.from("c"), aData = Buffer.from("ca"), bData = Buffer.from("cab");
  const baseOid = blobOid(baseData), aOid = blobOid(aData), bOid = blobOid(bData);
  const aFromB = Buffer.from([3, 2, 0x90, 2]); // Copy first 2 bytes of "cab" -> "ca"
  const aFromC = Buffer.from([1, 2, 0x90, 1, 1, 97]); // Copy "c" + insert "a" -> "ca"
  const bFromA = Buffer.from([2, 3, 0x90, 2, 1, 98]); // Copy "ca" + insert "b" -> "cab"
  const aSecondEntry = deltaOnly
    ? { type: 7, base: Buffer.from(baseOid, "hex"), data: aFromC }
    : { type: 3, data: aData };
  const aSecondLength = packEntryHeader(aSecondEntry.type, aSecondEntry.data.length).length
    + (aSecondEntry.base?.length ?? 0) + deflateSync(aSecondEntry.data).length;
  const entries = [
    ...(deltaOnly ? [{ type: 3, data: baseData }] : []),
    // Entry A1 (REF_DELTA on B) appears before A2, while B is an OFS_DELTA referencing A2's exact offset.
    { type: 7, base: Buffer.from(bOid, "hex"), data: aFromB },
    aSecondEntry,
    { type: 6, base: Buffer.from([aSecondLength]), data: bFromA },
  ];
  const response = await receive(bucket, pushBody(entries, bOid));
  expect(response.status).toBe(200);
  expect(await response.text()).toContain(`ok refs/tags/test-${bOid}`);

  const reader = new GitObjectReader(readGitRepository(bucket as never, repoId));
  expect(Buffer.from(await reader.read(aOid))).toEqual(aData);
  expect(Buffer.from(await reader.read(bOid))).toEqual(bData);
  expect(Buffer.from(await new Response(await reader.stream(aOid)).arrayBuffer())).toEqual(aData);
  expect(Buffer.from(await new Response(await reader.stream(bOid)).arrayBuffer())).toEqual(bData);

  // Rewriting the pack using OID-based entries (packEntries / packed) must stay acyclic and readable.
  const packName = [...bucket.objects.keys()].find((key) => key.endsWith(".pack"))!.split("/").at(-1)!;
  const exported = await reader.packEntries(packName);
  const rewritten = createGitPack([...exported].map(([oid, entry]) => ({ oid, entry })), { index: true });
  const copy = new Bucket();
  const root = `git/repos/${repoId}/repo.git/objects/pack/rewritten`;
  await copy.put(`${root}.pack`, new Uint8Array(await new Response(rewritten.stream()).arrayBuffer()));
  await copy.put(`${root}.idx`, rewritten.index!);
  const reopened = new GitObjectReader(readGitRepository(copy as never, repoId));
  expect(Buffer.from(await reopened.read(aOid))).toEqual(aData);
  expect(Buffer.from(await reopened.read(bOid))).toEqual(bData);
  expect((await reader.packed(aOid)).base).not.toBe(bOid);
});
it("accepts a thin push referencing a stored object whose OFS_DELTA chain traverses duplicate OID representations", async () => {
  const bucket = new Bucket();
  const aData = Buffer.from("ca"), bData = Buffer.from("cab"), cData = Buffer.from("cab!"), dData = Buffer.from("cab?");
  const bOid = blobOid(bData), cOid = blobOid(cData), dOid = blobOid(dData);
  const aIdentity = Buffer.from([2, 2, 0x90, 2]); // Copy 2 bytes of "ca" -> "ca" (identity OFS_DELTA A' -> A)
  const bFromA = Buffer.from([2, 3, 0x90, 2, 1, 98]); // Copy "ca" + insert "b" -> "cab"
  const cFromB = Buffer.from([3, 4, 0x90, 3, 1, 33]); // Copy "cab" + insert "!" -> "cab!"
  const dFromB = Buffer.from([3, 4, 0x90, 3, 1, 63]); // Copy "cab" + insert "?" -> "cab?"
  const entryLen = (type: number, data: Buffer, base?: Buffer) =>
    packEntryHeader(type, data.length).length + (base?.length ?? 0) + deflateSync(data).length;
  const fullALen = entryLen(3, aData);
  const identityALen = entryLen(6, aIdentity, Buffer.from([fullALen]));
  const firstPush = await receive(bucket, pushBody([
    { type: 3, data: aData },
    { type: 6, base: Buffer.from([fullALen]), data: aIdentity },
    { type: 6, base: Buffer.from([identityALen]), data: bFromA },
  ], bOid));
  expect(firstPush.status).toBe(200);
  expect(await firstPush.text()).toContain(`ok refs/tags/test-${bOid}`);

  // Subsequent thin push referencing B must reconstruct B -> A' -> A using physical entry keys.
  const thinPush = await receive(bucket, pushBody([
    { type: 7, base: Buffer.from(bOid, "hex"), data: cFromB },
    { type: 7, base: Buffer.from(bOid, "hex"), data: dFromB },
  ], cOid));
  expect(thinPush.status).toBe(200);
  expect(await thinPush.text()).toContain(`ok refs/tags/test-${cOid}`);

  const reader = new GitObjectReader(readGitRepository(bucket as never, repoId));
  expect(Buffer.from(await reader.read(bOid))).toEqual(bData);
  expect(Buffer.from(await reader.read(cOid))).toEqual(cData);
  expect(Buffer.from(await reader.read(dOid))).toEqual(dData);
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
