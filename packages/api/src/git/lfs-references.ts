import type { ObjectStore } from "./git-object-store";
import { readRefs } from "./git-refs";
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

/** The objects every loose and packed ref names. */
async function refTips(store: Pick<ObjectStore, "get" | "list">, gitdir: string): Promise<string[]> {
  return [...(await readRefs(store, gitdir)).values()];
}
