import git from "isomorphic-git";
import { concat, deflate, fromHex, sha1, toHex } from "git-fs-s3";
import type { GitObjectBucket } from "./git-object-store";
import { readGitRepository } from "./git-http";
import { reachableHistory } from "./lfs-references";

// Pushes store their packs as git-fs-s3 receives them; collection writes pack-<time>.
const PACK = /^(?:recv|pack)-(\d+)\.pack$/u;
const LOOSE = /\/objects\/([0-9a-f]{2})\/([0-9a-f]{38})$/u;
const OFS_DELTA = 6;
const REF_DELTA = 7;
const TYPE_CODES: { [type: string]: number } = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** One stored pack entry: its type and size header fields, its delta base, and its deflated bytes. */
type Entry = { type: number; size: number; base?: string; data: Uint8Array };

/** The object IDs and offsets of a version 2 pack index. */
function readIndex(index: Uint8Array): Map<number, string> {
  const view = new DataView(index.buffer, index.byteOffset, index.byteLength);
  if (index.byteLength < 8 + 256 * 4 || view.getUint32(0) !== 0xff744f63 || view.getUint32(4) !== 2)
    throw new Error("Unsupported Git pack index");
  const count = view.getUint32(8 + 255 * 4);
  const names = 8 + 256 * 4;
  const offsets = names + count * 24;
  if (index.byteLength < offsets + count * 4 + 40) throw new Error("Truncated Git pack index");
  const oids = new Map<number, string>();
  for (let i = 0; i < count; i++) {
    const offset = view.getUint32(offsets + i * 4);
    // Packs here stay far below 2 GiB, the first offset that needs the 64-bit table.
    if (offset & 0x80000000) throw new Error("Unsupported Git pack offset");
    oids.set(offset, toHex(index.subarray(names + i * 20, names + i * 20 + 20)));
  }
  return oids;
}

/** Splits a pack into its entries, keyed by object ID, keeping each one's compressed bytes. */
function readEntries(pack: Uint8Array, oids: Map<number, string>): Map<string, Entry> {
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  if (pack.byteLength < 32 || toHex(pack.subarray(0, 4)) !== "5041434b" || ![2, 3].includes(view.getUint32(4)) ||
      view.getUint32(8) !== oids.size) throw new Error("Git pack does not match its index");
  const offsets = [...oids.keys()].sort((a, b) => a - b);
  const entries = new Map<string, Entry>();
  for (const [i, start] of offsets.entries()) {
    const end = offsets[i + 1] ?? pack.byteLength - 20;
    let position = start;
    let byte = pack[position++];
    const type = (byte >> 4) & 7;
    let size = byte & 15;
    for (let scale = 16; byte & 0x80; scale *= 128) { byte = pack[position++]; size += (byte & 0x7f) * scale; }
    let base: string | undefined;
    if (type === OFS_DELTA) {
      byte = pack[position++];
      let distance = byte & 0x7f;
      while (byte & 0x80) { byte = pack[position++]; distance = (distance + 1) * 128 + (byte & 0x7f); }
      base = oids.get(start - distance);
      if (!base) throw new Error("Git pack delta names no entry");
    } else if (type === REF_DELTA) {
      base = toHex(pack.subarray(position, position + 20));
      position += 20;
    } else if (type < 1 || type > 4) throw new Error("Unsupported Git pack entry");
    if (position > end) throw new Error("Truncated Git pack entry");
    entries.set(oids.get(start)!, { type, size, base, data: pack.subarray(position, end) });
  }
  return entries;
}

/** A version 2 index: header, fanout, then a name, CRC and offset per object, and two checksums. */
const indexBytes = (objects: number) => 8 + 256 * 4 + objects * 28 + 40;

function entryHeader(type: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let byte = (type << 4) | (size & 15);
  for (let rest = Math.floor(size / 16); rest > 0; rest = Math.floor(rest / 128)) {
    bytes.push(byte | 0x80);
    byte = rest & 0x7f;
  }
  bytes.push(byte);
  return Uint8Array.from(bytes);
}

/**
 * Removes the Git objects no branch or tag reaches, such as the commits of a
 * deleted branch. The reachable objects move into one new pack, copied as
 * stored so deltas stay compressed; a pushed pack can hold deltas against
 * objects of older packs, so the bases of kept deltas stay too. Old packs and
 * loose objects are deleted only after the new pack indexes to exactly the
 * kept objects. The caller must hold the repository's queue, so no push runs
 * meanwhile. Returns the bytes before and after, or null when nothing is
 * unreachable or the rewrite would not shrink the stored history.
 */
export async function collectUnreachableHistory(bucket: GitObjectBucket, repoId: string):
  Promise<{ objects: number; bytes: number; remainingBytes: number } | null> {
  const opened = readGitRepository(bucket, repoId);
  const { store, prefix, fs, repo } = opened;
  const reachable = (await reachableHistory(opened)).objects;
  const objectsPrefix = `${prefix}${repo.gitdir}/objects/`;
  const listing = (await store.list(objectsPrefix)).objects;
  const packDir = `${repo.gitdir}/objects/pack`;
  const packs: { name: string; time: number; entries: Map<string, Entry> }[] = [];
  const loose = new Map<string, string>();
  const removable: string[] = [];
  let bytes = 0;
  for (const { key, size } of listing) {
    const name = key.slice(`${objectsPrefix}pack/`.length);
    const looseOid = LOOSE.exec(key);
    if (looseOid) { loose.set(looseOid[1] + looseOid[2], key); bytes += size; continue; }
    if (!key.startsWith(`${objectsPrefix}pack/`)) continue;
    if (name.endsWith(".idx")) {
      if (!listing.some((object) => object.key === key.replace(/\.idx$/u, ".pack")))
        throw new Error(`Git pack index ${name} has no pack`);
      continue;
    }
    if (!name.endsWith(".pack")) throw new Error(`Unexpected Git pack file ${name}`);
    const time = PACK.exec(name)?.[1];
    if (time === undefined) throw new Error(`Unexpected Git pack name ${name}`);
    bytes += size;
    const index = await store.get(key.replace(/\.pack$/u, ".idx"));
    // A pack whose push stopped before indexing holds nothing Git can read.
    if (!index) { removable.push(key); continue; }
    bytes += index.byteLength;
    const pack = await fs.promises.readFile(`${packDir}/${name}`) as Uint8Array;
    packs.push({ name, time: Number(time), entries: readEntries(pack, readIndex(index)) });
    removable.push(key.replace(/\.pack$/u, ".idx"), key);
  }
  removable.push(...loose.values());

  // A pushed pack's deltas name only bases from its own pack or older packs, so
  // taking each object from the oldest pack that holds it keeps deltas acyclic.
  packs.sort((a, b) => a.time - b.time || a.name.localeCompare(b.name));
  const chosen = new Map<string, Entry>();
  let stored = loose.size;
  for (const pack of packs) {
    stored += pack.entries.size;
    for (const [oid, entry] of pack.entries) if (!chosen.has(oid)) chosen.set(oid, entry);
  }
  const kept = new Set<string>();
  for (const pending = [...reachable]; pending.length;) {
    const oid = pending.pop()!;
    if (kept.has(oid)) continue;
    kept.add(oid);
    const entry = chosen.get(oid);
    if (entry?.base) pending.push(entry.base);
    else if (!entry && !loose.has(oid)) throw new Error(`Git object ${oid} is not stored`);
  }
  const unreachable = [...chosen.keys(), ...loose.keys()].filter((oid) => !kept.has(oid));
  // Duplicates across packs count too: the rewrite stores each object once.
  if (!unreachable.length && stored === kept.size) return null;

  // Each delta follows its base, so indexing the new pack never looks outside it.
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (oid: string) => {
    if (state.get(oid) === "done") return;
    if (state.get(oid) === "visiting") throw new Error("Git pack deltas form a cycle");
    state.set(oid, "visiting");
    const base = chosen.get(oid)?.base;
    if (base) visit(base);
    state.set(oid, "done");
    order.push(oid);
  };
  for (const oid of kept) visit(oid);
  const header = new Uint8Array(12);
  header.set([0x50, 0x41, 0x43, 0x4b]);
  new DataView(header.buffer).setUint32(4, 2);
  new DataView(header.buffer).setUint32(8, order.length);
  const chunks: Uint8Array[] = [header];
  for (const oid of order) {
    const entry = chosen.get(oid);
    if (entry?.base) chunks.push(entryHeader(REF_DELTA, entry.size), fromHex(entry.base), entry.data);
    else if (entry) chunks.push(entryHeader(entry.type, entry.size), entry.data);
    else {
      const { type, object } = await git.readObject({ ...repo, oid, format: "content" });
      const content = object as Uint8Array;
      chunks.push(entryHeader(TYPE_CODES[type], content.byteLength), await deflate(content));
    }
  }
  const body = concat(...chunks);
  const pack = concat(body, fromHex(await sha1(body)));
  // A rewritten delta names its base in 20 bytes, so freeing almost nothing
  // could grow the history toward its limit; such garbage waits for more.
  if (pack.byteLength + indexBytes(order.length) >= bytes) return null;
  const name = `pack-${Date.now()}.pack`;
  if (packs.some((existing) => existing.name === name)) throw new Error("Git pack name is taken");
  await fs.promises.writeFile(`${packDir}/${name}`, pack);
  const { oids } = await git.indexPack({ ...repo, dir: packDir, filepath: name });
  if (oids.length !== kept.size || oids.some((oid) => !kept.has(oid))) {
    await store.delete(`${objectsPrefix}pack/${name.replace(/\.pack$/u, ".idx")}`);
    await store.delete(`${objectsPrefix}pack/${name}`);
    throw new Error("Collected Git pack does not hold exactly the kept objects");
  }
  // Each index goes before its pack, so a partial run leaves only readable packs.
  for (const key of removable) await store.delete(key);
  return { objects: unreachable.length, bytes, remainingBytes: pack.byteLength + indexBytes(order.length) };
}

