import git from "isomorphic-git";
import type { ObjectStore } from "git-fs-s3";
import type { GitObjectBucket } from "./git-object-store";
import { readGitRepository } from "./git-http";

/**
 * The object a small blob points to. Over-matching only keeps an object
 * longer, so any `oid sha256:` line counts, without the pointer's other fields.
 */
export function lfsPointerOid(blob: Uint8Array): string | null {
  // Git LFS never reads a blob larger than this as a pointer.
  if (blob.byteLength > 1024) return null;
  return /^oid sha256:([0-9a-f]{64})\r?$/mu.exec(new TextDecoder().decode(blob))?.[1] ?? null;
}

/**
 * LFS OIDs whose pointer any branch or tag reaches, anywhere in its history.
 * An unreadable ref or object throws instead of returning a partial set, since
 * a missed pointer would make a referenced object look collectable.
 */
export async function referencedLfsOids(bucket: GitObjectBucket, repoId: string): Promise<Set<string>> {
  return (await reachableHistory(readGitRepository(bucket, repoId))).lfs;
}

/**
 * Every object a branch or tag reaches, and the LFS OIDs whose pointers are
 * among them. Any unreadable ref or object throws, so a partial history never
 * makes a needed object look unreachable.
 */
export async function reachableHistory(
  { store, prefix, fs, repo }: ReturnType<typeof readGitRepository>,
): Promise<{ objects: Set<string>; lfs: Set<string> }> {
  await fs.detectLooseObjects(repo.gitdir);
  await fs.prefetchPacks(repo.gitdir);
  const pending = await refTips(store, `${prefix}${repo.gitdir}/`);
  const seen = new Set<string>();
  const lfs = new Set<string>();
  for (let oid = pending.pop(); oid !== undefined; oid = pending.pop()) {
    if (seen.has(oid)) continue;
    seen.add(oid);
    // A missing object throws NotFoundError, so a partial history cannot pass.
    const read = await git.readObject({ ...repo, oid, format: "parsed" });
    if (read.type === "blob") {
      // Blobs come back as content bytes even when parsing is requested.
      const pointer = lfsPointerOid(typeof read.object === "string" ? new TextEncoder().encode(read.object) : read.object);
      if (pointer) lfs.add(pointer);
    } else if (read.format !== "parsed") throw new Error(`Git object ${oid} could not be parsed`);
    else if (read.type === "commit") pending.push(read.object.tree, ...read.object.parent);
    else if (read.type === "tag") pending.push(read.object.object);
    // A submodule entry names a commit in another repository.
    else if (read.type === "tree") pending.push(...read.object.filter((entry) => entry.type !== "commit").map((entry) => entry.oid));
  }
  return { objects: seen, lfs };
}

/**
 * Every loose and packed ref, by full name, with the object it names.
 * isomorphic-git reports a ref listing failure as an empty list, so refs are
 * read from the store, which throws instead.
 */
export async function readRefs(store: Pick<ObjectStore, "get" | "list">, gitdir: string): Promise<Map<string, string>> {
  const refs = new Map<string, string>();
  // Each read is a round trip to the bucket, so they all go out at once.
  const [listing, packed] = await Promise.all([store.list(`${gitdir}refs/`), store.get(`${gitdir}packed-refs`)]);
  const loose = await Promise.all(listing.objects.map(async ({ key }) => {
    const content = await store.get(key);
    if (!content) throw new Error(`Git ref ${key} disappeared while it was read`);
    return [key, new TextDecoder().decode(content).trim()] as const;
  }));
  for (const [key, value] of loose) {
    // A symbolic ref names another ref, which the listing includes too.
    if (value.startsWith("ref: ")) continue;
    if (!/^[0-9a-f]{40}$/u.test(value)) throw new Error(`Git ref ${key} is not an object ID`);
    refs.set(key.slice(gitdir.length), value);
  }
  for (const line of packed ? new TextDecoder().decode(packed).split("\n") : []) {
    // Comments, blank lines and peeled tag targets name no ref of their own.
    if (line === "" || line.startsWith("#") || /^\^[0-9a-f]{40}$/u.test(line)) continue;
    const entry = /^([0-9a-f]{40}) (refs\/\S+)$/u.exec(line);
    // A damaged line could be the only ref to a pointer.
    if (!entry) throw new Error("Git packed-refs has an unreadable line");
    // A loose ref supersedes its packed entry.
    if (!refs.has(entry[2])) refs.set(entry[2], entry[1]);
  }
  return refs;
}

/** The objects every loose and packed ref names. */
async function refTips(store: Pick<ObjectStore, "get" | "list">, gitdir: string): Promise<string[]> {
  return [...(await readRefs(store, gitdir)).values()];
}
