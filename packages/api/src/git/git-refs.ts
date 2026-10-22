import type { ObjectStore } from "./git-object-store";

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
