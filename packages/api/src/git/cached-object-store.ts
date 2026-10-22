import type { ObjectStore, ListOptions } from "./git-object-store";

/** The repository queue drops this cache before any external write (push, collection or deletion). */
export function cacheGitObjectStore(store: ObjectStore, { maxBytes, ttlMs }: { maxBytes: number; ttlMs: number }): ObjectStore {
  const entries = new Map<string, { value: unknown; size: number; expires: number }>();
  const pending = new Map<string, Promise<unknown>>();
  let bytes = 0, generation = 0;
  function remove(key: string) {
    const entry = entries.get(key);
    if (entry) { bytes -= entry.size; entries.delete(key); }
  }
  function clear() { entries.clear(); pending.clear(); bytes = 0; generation++; }
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
      // Include metadata and keys in the budget, including negative lookups.
      const size = sizeOf(value) + key.length * 2 + 128;
      if (version === generation && size <= maxBytes) {
        while (entries.size && (bytes + size > maxBytes || entries.size >= 10_000)) remove(entries.keys().next().value!);
        entries.set(key, { value, size, expires: Date.now() + ttlMs }); bytes += size;
      }
      return value;
    }).finally(() => { if (pending.get(key) === result) pending.delete(key); });
    pending.set(key, result);
    return result;
  }
  async function write(work: () => Promise<void>) {
    clear();
    try { await work(); } finally { clear(); }
  }
  return {
    get: (key) => read(`get:${key}`, () => store.get(key), (value) => value?.byteLength ?? 0),
    head: (key) => read(`head:${key}`, () => store.head(key), () => 16),
    list: (prefix, options: ListOptions = {}) => read(JSON.stringify(["list", prefix, options.delimiter, options.limit]),
      () => store.list(prefix, options), (value) => value.objects.reduce((size, entry) => size + entry.key.length * 2 + 32, 0)
        + value.prefixes.reduce((size, entry) => size + entry.length * 2 + 16, 0)),
    put: (key, value) => write(() => store.put(key, value)),
    delete: (key) => write(() => store.delete(key)),
  };
}
