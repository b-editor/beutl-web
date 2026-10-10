import { createHash } from "node:crypto";
import { GitObjectReader, type PackedGitEntry } from "./object-reader";
import { createGitPack, gitIndexBytes } from "./pack-writer";
import { streamBytes } from "./streams";
import type { GitObjectBucket } from "./git-object-store";
import { readGitRepository } from "./git-http";
import { reachableHistory } from "./lfs-references";

// Pushes store their packs as git-fs-s3 receives them; collection writes pack-<time>.
const PACK = /^(?:recv|pack)-(\d+)\.pack$/u;
const LOOSE = /\/objects\/([0-9a-f]{2})\/([0-9a-f]{38})$/u;

type Entry = PackedGitEntry;

/**
 * Removes the Git objects no branch or tag reaches, such as the commits of a
 * deleted branch. The reachable objects move into one new pack, copied as
 * stored so deltas stay compressed; a pushed pack can hold deltas against
 * objects of older packs, so the bases of kept deltas stay too. Old packs and
 * loose objects are deleted only after the new pack indexes to exactly the
 * kept objects. The caller must hold the repository's queue, so no push runs
 * meanwhile. Packs a push left unindexed are deleted in any case. Returns the
 * bytes before and after, or null when nothing was deleted.
 */
export async function collectUnreachableHistory(bucket: GitObjectBucket, repoId: string):
  Promise<{ objects: number; bytes: number; remainingBytes: number } | null> {
  const opened = readGitRepository(bucket, repoId);
  const { store, prefix, repo } = opened;
  const reader = new GitObjectReader(opened);
  const reachable = (await reachableHistory(opened, reader)).objects;
  const objectsPrefix = `${prefix}${repo.gitdir}/objects/`;
  const listing = (await store.list(objectsPrefix)).objects;
  const packs: { name: string; time: number; entries: Map<string, Entry> }[] = [];
  const loose = new Map<string, string>();
  const removable: string[] = [];
  // Packs whose push stopped before indexing hold nothing Git can read.
  const unindexed: { key: string; size: number }[] = [];
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
    const indexKey = key.replace(/\.pack$/u, ".idx");
    if (!listing.some((object) => object.key === indexKey)) { unindexed.push({ key, size }); continue; }
    bytes += listing.find((object) => object.key === indexKey)!.size;
    packs.push({ name, time: Number(time), entries: await reader.packEntries(name) });
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
  // Without a rewrite, only the unindexed packs go.
  const dropUnindexed = async () => {
    if (!unindexed.length) return null;
    for (const { key } of unindexed) await store.delete(key);
    return { objects: 0, bytes, remainingBytes: bytes - unindexed.reduce((sum, { size }) => sum + size, 0) };
  };
  // Duplicates across packs count too: the rewrite stores each object once.
  if (!unreachable.length && stored === kept.size) return dropUnindexed();

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
  const entries: { oid: string; entry: Entry }[] = [];
  for (const oid of order) entries.push({ oid, entry: chosen.get(oid) ?? await reader.packed(oid) });
  const pack = createGitPack(entries, { index: true });
  // Replacing relative delta offsets by named bases can grow a nearly unchanged pack.
  if (pack.byteLength + gitIndexBytes(order.length) >= bytes) return dropUnindexed();
  const name = `pack-${Date.now()}.pack`;
  if (packs.some((existing) => existing.name === name)) throw new Error("Git pack name is taken");
  const packKey = `${objectsPrefix}pack/${name}`, indexKey = packKey.replace(/\.pack$/u, ".idx");
  try {
    if (bucket.putStream) await bucket.putStream(packKey, pack.stream(), pack.byteLength);
    else await store.put(packKey, await streamBytes(pack.stream(), pack.byteLength));
    const stored = await store.get(packKey);
    if (!stored || stored.byteLength !== pack.byteLength ||
        createHash("sha1").update(stored.subarray(0, -20)).digest("hex") !== pack.checksum)
      throw new Error("Collected Git pack differs from its staged contents");
    await store.put(indexKey, pack.index!);
    const verified = await new GitObjectReader(readGitRepository(bucket, repoId)).packEntries(name);
    if (verified.size !== kept.size || [...verified.keys()].some((oid) => !kept.has(oid)))
      throw new Error("Collected Git pack does not hold exactly the kept objects");
  } catch (error) {
    await store.delete(indexKey); await store.delete(packKey); throw error;
  }
  // Each index goes before its pack, so a partial run leaves only readable packs.
  for (const key of [...removable, ...unindexed.map(({ key }) => key)]) await store.delete(key);
  return { objects: unreachable.length, bytes, remainingBytes: pack.byteLength + gitIndexBytes(order.length) };
}

