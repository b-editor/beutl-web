import type { ObjectStore } from "./git-object-store";

/**
 * Every loose and packed ref, by full name, with the object it names.
 * isomorphic-git reports a ref listing failure as an empty list, so refs are
 * read from the store, which throws instead.
 */
export async function readRefs(store: Pick<ObjectStore, "get" | "list">, gitdir: string): Promise<Map<string, string>> {
  return (await readRefSnapshot(store, gitdir)).refs;
}

export async function readRefSnapshot(store: Pick<ObjectStore, "get" | "list">, gitdir: string,
  { refKeys, hasPackedRefs }: { refKeys?: string[]; hasPackedRefs?: boolean } = {}) {
  const refs = new Map<string, string>();
  // Each read is a round trip to the bucket, so they all go out at once.
  const [keys, packed] = await Promise.all([
    refKeys ?? store.list(`${gitdir}refs/`).then(({ objects }) => objects.map(({ key }) => key)),
    hasPackedRefs === false ? null : store.get(`${gitdir}packed-refs`),
  ]);
  const loose = await Promise.all(keys.map(async (key) => {
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
  const packedRefs: { text: string; name?: string }[] = [];
  let previousName: string | undefined;
  for (const text of packed ? new TextDecoder().decode(packed).split("\n") : []) {
    if (/^\^[0-9a-f]{40}$/u.test(text)) {
      packedRefs.push({ text, name: previousName });
      continue;
    }
    if (text === "" || text.startsWith("#")) {
      packedRefs.push({ text }); previousName = undefined;
      continue;
    }
    const entry = /^([0-9a-f]{40}) (refs\/\S+)$/u.exec(text);
    // A damaged line could be the only ref to a pointer.
    if (!entry) throw new Error("Git packed-refs has an unreadable line");
    // A loose ref supersedes its packed entry.
    const [, oid, name] = entry;
    if (!refs.has(name)) refs.set(name, oid);
    packedRefs.push({ text, name }); previousName = name;
  }
  return { refs, packedRefs };
}
