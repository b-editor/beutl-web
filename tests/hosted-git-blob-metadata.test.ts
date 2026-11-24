import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { GitObjectReader as GitBlobMetadataReader } from "../packages/api/src/git/object-reader";
import { readGitRepository } from "../packages/api/src/git/git-http";
import { createGitPack } from "../packages/api/src/git/pack-writer";

const prefix = "git/repos/repro/repo.git/";
const base = randomBytes(65_536);
const contents = [base, Buffer.concat([base, Buffer.from("appended content")]), Buffer.alloc(256 * 1024, 7), Buffer.alloc(0)];
let root: string, oids: string[];
const loose = new Map<string, Uint8Array>();
const packed = new Map<string, { files: Map<string, Uint8Array>; types: number[] }>();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "beutl-git-blob-metadata-"));
  const git = (args: string[], input?: string | Uint8Array) => execFileSync("git", ["--git-dir", join(root, "repo.git"), ...args], {
    input, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, maxBuffer: 4 * 1024 * 1024,
  });
  git(["init", "--bare", "-q"]);
  oids = contents.map((bytes) => git(["hash-object", "-w", "--stdin"], bytes).toString().trim());
  for (const oid of oids) {
    const path = `objects/${oid.slice(0, 2)}/${oid.slice(2)}`;
    loose.set(prefix + path, readFileSync(join(root, "repo.git", path)));
  }
  for (const [kind, flags] of [["ref", []], ["ofs", ["--delta-base-offset"]]] as const) {
    const pack = git(["pack-objects", "--stdout", "--window=10", "--depth=10", "--threads=1", ...flags], oids.join("\n") + "\n");
    const path = join(root, `${kind}.pack`);
    writeFileSync(path, pack);
    git(["index-pack", path]);
    const index = readFileSync(join(root, `${kind}.idx`));
    const rows = git(["verify-pack", "-v", join(root, `${kind}.idx`)]).toString().split("\n").filter((line) => /^[0-9a-f]{40} /u.test(line));
    packed.set(kind, { files: new Map([[`${prefix}objects/pack/${kind}.pack`, pack], [`${prefix}objects/pack/${kind}.idx`, index]]),
      types: rows.map((row) => (pack[Number(row.split(/\s+/u)[4])] >> 4) & 7) });
  }
});

afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

function open(files: Map<string, Uint8Array>) {
  const bucket = {
    get: vi.fn(async (key: string) => {
      const bytes = files.get(key);
      return bytes ? { size: bytes.byteLength, arrayBuffer: async () => Uint8Array.from(bytes).buffer } : null;
    }),
    async head(key: string) { const bytes = files.get(key); return bytes ? { size: bytes.byteLength } : null; },
    async list({ prefix, delimiter }: { prefix: string; delimiter?: string }) {
      const objects = [], prefixes = new Set<string>();
      for (const [key, bytes] of files) if (key.startsWith(prefix)) {
        const position = delimiter ? key.slice(prefix.length).indexOf(delimiter) : -1;
        if (position < 0) objects.push({ key, size: bytes.byteLength });
        else prefixes.add(key.slice(0, prefix.length + position + delimiter!.length));
      }
      return { objects, delimitedPrefixes: [...prefixes], truncated: false };
    },
  };
  return { reader: new GitBlobMetadataReader(readGitRepository(bucket as never, "repro")), bucket };
}

async function packFiles(name: string, entries: Parameters<typeof createGitPack>[0]) {
  const pack = createGitPack(entries, { index: true }), path = `${prefix}objects/pack/${name}`;
  return new Map<string, Uint8Array>([
    [`${path}.pack`, new Uint8Array(await new Response(pack.stream()).arrayBuffer())], [`${path}.idx`, pack.index!],
  ]);
}

async function streamObject(reader: GitBlobMetadataReader, oid: string) {
  return new Uint8Array(await new Response(await reader.stream(oid)).arrayBuffer());
}

describe("Git blob size metadata", () => {
  it("reads only the header of loose blobs, including empty and compressible files", async () => {
    const { reader } = open(loose);
    expect(await Promise.all(oids.map((oid) => reader.size(oid)))).toEqual(contents.map((bytes) => bytes.byteLength));
    expect(await reader.size("f".repeat(40))).toBeNull();
  });

  it("materializes loose blobs identically to streaming", async () => {
    const { reader } = open(loose);
    for (let i = 0; i < oids.length; i++) {
      const bytes = await reader.read(oids[i]);
      expect(bytes).toEqual(new Uint8Array(contents[i]));
      expect(bytes).toEqual(await streamObject(reader, oids[i]));
    }
  });

  it.each(["ref", "ofs"])("reads normal and %s-delta result sizes from native Git packs", async (kind) => {
    const fixture = packed.get(kind)!;
    expect(fixture.types).toContain(kind === "ref" ? 7 : 6);
    expect(fixture.types).toContain(3);
    const { reader, bucket } = open(fixture.files);
    expect(await Promise.all(oids.map((oid) => reader.size(oid)))).toEqual(contents.map((bytes) => bytes.byteLength));
    expect(await reader.size(oids[0])).toBe(contents[0].byteLength);
    expect(bucket.get.mock.calls.filter(([key]) => key.endsWith(".pack"))).toHaveLength(1);
    expect(bucket.get.mock.calls.filter(([key]) => key.endsWith(".idx"))).toHaveLength(1);
    expect(await reader.size("f".repeat(40))).toBeNull();
  });

  it.each(["ref", "ofs"])("streams %s deltas, including ranges across base and inserted bytes", async (kind) => {
    const { reader } = open(packed.get(kind)!.files);
    for (let i = 0; i < oids.length; i++) {
      const bytes = await reader.read(oids[i]);
      expect(bytes).toEqual(new Uint8Array(contents[i]));
      expect(bytes).toEqual(await streamObject(reader, oids[i]));
    }
    const offset = base.byteLength - 5, length = 17;
    const range = await reader.stream(oids[1], { offset, length });
    expect(new Uint8Array(await new Response(range).arrayBuffer())).toEqual(new Uint8Array(contents[1].subarray(offset, offset + length)));
  });

  it("prefetches indexes on ordinary reads and skips speculative prefetch when a lookup budget applies", async () => {
    const path = `${prefix}objects/pack/`, files = new Map(packed.get("ref")!.files);
    const unavailable = `${path}z.idx`, failure = new Error("B2 index read failed");
    files.set(unavailable, new Uint8Array());
    const monitored = () => {
      const { reader, bucket } = open(files), read = bucket.get.getMockImplementation()!;
      bucket.get.mockImplementation(async (key) => {
        if (key === unavailable) throw failure;
        return read(key);
      });
      return { reader, bucket };
    };
    const direct = monitored();
    expect(await direct.reader.size(oids[3])).toBe(0);
    expect(direct.bucket.get).not.toHaveBeenCalledWith(unavailable);

    for (const [key, bytes] of await packFiles("a", [])) files.set(key, bytes);
    const ordinary = monitored();
    expect(await ordinary.reader.size(oids[3])).toBe(0);
    expect(ordinary.bucket.get.mock.calls.map(([key]) => key).filter((key) => key.startsWith(path)))
      .toEqual([`${path}a.idx`, `${path}ref.idx`, unavailable, `${path}ref.pack`]);
    await expect(ordinary.reader.size("f".repeat(40))).rejects.toBe(failure);

    const budgeted = monitored();
    let remaining = 2;
    const consume = vi.fn(() => { if (--remaining < 0) throw new Error("budget exceeded"); });
    await expect(budgeted.reader.size(oids[3], consume)).rejects.toThrow("budget exceeded");
    expect(budgeted.bucket.get.mock.calls.map(([key]) => key).filter((key) => key.startsWith(path)))
      .toEqual([`${path}a.idx`]);
  });

  it("enforces the read limit and can still stream a small delta based on a legacy loose blob", async () => {
    const legacyOid = "a".repeat(40), oid = "b".repeat(40), size = 24 * 1024 * 1024;
    const header = Buffer.from(`blob ${size}\0`), body = Buffer.alloc(header.length + size, 7);
    header.copy(body);
    const instructions = Buffer.from([0x80, 0x80, 0x80, 12, 1, 0x90, 1]); // Copy the first byte of a 24 MiB base.
    const files = await packFiles("legacy", [{ oid, entry: { type: 7, size: instructions.length, base: legacyOid, data: deflateSync(instructions) } }]);
    files.set(`${prefix}objects/${legacyOid.slice(0, 2)}/${legacyOid.slice(2)}`, deflateSync(body));
    const { reader } = open(files);
    expect(await reader.size(legacyOid)).toBe(size);
    await expect(reader.read(legacyOid)).rejects.toThrow("read limit");
    await expect(reader.read(oid, 0)).rejects.toThrow("read limit");
    expect(await reader.read(oid)).toEqual(Uint8Array.of(7));
    expect(await streamObject(reader, oid)).toEqual(Uint8Array.of(7));
  });

  it.each([
    { problem: "mismatched base size", bytes: [1, 1, 1, 98] },
    { problem: "out-of-bounds copy", bytes: [0, 1, 0x90, 1] },
    { problem: "out-of-bounds insert", bytes: [0, 1, 2, 98, 99] },
    { problem: "excess instructions", bytes: [0, 1, 1, 98, 1, 99] },
    { problem: "truncated zlib stream", bytes: [0, 1, 1, 98], truncate: true },
  ])("rejects $problem in synchronous and streamed delta reads", async ({ bytes, truncate }) => {
    const oid = "f".repeat(40), compressed = deflateSync(Uint8Array.from(bytes));
    const files = await packFiles("bad", [
      { oid: oids[3], entry: { type: 3, size: 0, data: deflateSync(Buffer.alloc(0)) } },
      { oid, entry: { type: 7, size: bytes.length, base: oids[3], data: truncate ? compressed.subarray(0, -1) : compressed } },
    ]);
    const { reader } = open(files);
    await expect(reader.read(oid)).rejects.toThrow();
    await expect(streamObject(reader, oid)).rejects.toThrow();
  });

  it("rejects cyclic delta bases in synchronous and streamed reads", async () => {
    const ids = ["a".repeat(40), "b".repeat(40)], bytes = Uint8Array.of(1, 1, 0x90, 1);
    const { reader } = open(await packFiles("cycle", ids.map((oid, i) => ({
      oid, entry: { type: 7, size: bytes.length, base: ids[1 - i], data: deflateSync(bytes) },
    }))));
    await expect(reader.read(ids[0])).rejects.toThrow("cycle");
    await expect(streamObject(reader, ids[0])).rejects.toThrow("cycle");
  });

  it("pins compressed delta inputs before storage changes and supports cancellation", async () => {
    const files = new Map(packed.get("ofs")!.files), { reader } = open(files);
    const stream = await reader.stream(oids[1], { offset: 30, length: 10 });
    files.clear();
    const cursor = stream.getReader();
    expect((await cursor.read()).value).toEqual(new Uint8Array(contents[1].subarray(30, 40)));
    await cursor.cancel(); cursor.releaseLock();
    expect(await reader.read(oids[1])).toEqual(new Uint8Array(contents[1]));
  });

  it.each(["idx", "pack", "pack trailer"])("rejects a damaged %s instead of returning misleading metadata", async (damage) => {
    const extension = damage === "idx" ? "idx" : "pack";
    const files = new Map(packed.get("ofs")!.files);
    const key = `${prefix}objects/pack/ofs.${extension}`;
    const damaged = Uint8Array.from(files.get(key)!);
    damaged[damaged.byteLength - (damage === "pack trailer" ? 1 : 41)] ^= 1;
    files.set(key, damaged);
    await expect(open(files).reader.size(oids[0])).rejects.toThrow(/checksum/u);
  });
});
