import type { ObjectStore, ListOptions } from "./git-object-store";

/** Repository writes update this cache. Maintenance outside the store drops it. */
export function cacheGitObjectStore(store: ObjectStore, { maxBytes, ttlMs }: { maxBytes: number; ttlMs: number }): ObjectStore {
  const entries = new Map<string, { value: unknown; size: number; expires: number }>();
  const pending = new Map<string, Promise<unknown>>();
  let bytes = 0, generation = 0;
  function remove(key: string) {
    const entry = entries.get(key);
    if (entry) { bytes -= entry.size; entries.delete(key); }
  }
  // Include metadata and keys in the budget, including negative lookups.
  const entrySize = (key: string, size: number) => size + key.length * 2 + 128;
  function cache(key: string, value: unknown, size: number) {
    if (size > maxBytes) return;
    remove(key);
    while (entries.size && (bytes + size > maxBytes || entries.size >= 10_000)) remove(entries.keys().next().value!);
    entries.set(key, { value, size, expires: Date.now() + ttlMs }); bytes += size;
  }
  function invalidate(key: string) {
    generation++;
    pending.clear();
    for (const entryKey of entries.keys()) if (entryKey.startsWith("list:")) remove(entryKey);
    remove(`get:${key}`);
    remove(`head:${key}`);
  }
  async function read<T>(key: string, load: () => Promise<T>, sizeOf: (value: T) => number): Promise<T> {
    const cached = entries.get(key);
    if (cached && cached.expires > Date.now()) {
      entries.delete(key); entries.set(key, cached);
      return cached.value as T;
    }
    remove(key);
    const running = pending.get(key);
    if (running) return running as Promise<T>;
    const version = generation;
    const result = load().then((value) => {
      if (version === generation) cache(key, value, entrySize(key, sizeOf(value)));
      return value;
    }).finally(() => { if (pending.get(key) === result) pending.delete(key); });
    pending.set(key, result);
    return result;
  }
  async function write(key: string, work: () => Promise<void>, value: Uint8Array | null) {
    invalidate(key);
    // Clear reads started during the write too, even when B2 reports failure.
    try { await work(); } finally { invalidate(key); }
    const getKey = `get:${key}`, headKey = `head:${key}`;
    const size = entrySize(getKey, value?.byteLength ?? 0);
    // Insert bytes last so the smaller HEAD entry cannot evict them.
    cache(headKey, value ? { size: value.byteLength } : null, entrySize(headKey, 16));
    if (size <= maxBytes) cache(getKey, value ? Uint8Array.from(value) : null, size);
  }
  return {
    get: (key) => read(`get:${key}`, () => store.get(key), (value) => value?.byteLength ?? 0),
    head: (key) => read(`head:${key}`, () => store.head(key), () => 16),
    list: (prefix, options: ListOptions = {}) => read(`list:${JSON.stringify([prefix, options.delimiter, options.limit])}`,
      () => store.list(prefix, options), (value) => value.objects.reduce((size, entry) => size + entry.key.length * 2 + 32, 0)
        + value.prefixes.reduce((size, entry) => size + entry.length * 2 + 16, 0)),
    put: (key, value) => write(key, () => store.put(key, value), value),
    delete: (key) => write(key, () => store.delete(key), null),
  };
}
