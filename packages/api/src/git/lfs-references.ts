import type { ObjectStore } from "git-fs-s3";
import type { GitObjectBucket } from "./git-object-store";
import { readGitRepository } from "./git-http";
import { GitObjectReader } from "./object-reader";
import { collectGitObjects } from "./object-graph";

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
  repository: ReturnType<typeof readGitRepository>,
  reader = new GitObjectReader(repository),
): Promise<{ objects: Set<string>; lfs: Set<string> }> {
  const { store, prefix, fs, repo } = repository;
  await fs.detectLooseObjects(repo.gitdir);
  const lfs = new Set<string>();
  const objects = await collectGitObjects(reader, await refTips(store, `${prefix}${repo.gitdir}/`), {
    async onBlob(oid, size) {
      if (size > 1024) return;
      const pointer = lfsPointerOid(await reader.read(oid, 1024));
      if (pointer) lfs.add(pointer);
    },
  });
  return { objects, lfs };
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
