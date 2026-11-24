import { afterEach, expect, it, vi } from "vitest";
import git from "../packages/api/node_modules/isomorphic-git/index.js";
import { GitFileSystem } from "../packages/api/src/git/git-filesystem";
import { cacheGitObjectStore } from "../packages/api/src/git/cached-object-store";
import type { ListOptions, ObjectStore } from "../packages/api/src/git/git-object-store";

class Store implements ObjectStore {
  objects = new Map<string, Uint8Array>();
  get = vi.fn(async (key: string) => this.objects.get(key) ?? null);
  head = vi.fn(async (key: string) => { const data = this.objects.get(key); return data ? { size: data.length } : null; });
  async put(key: string, data: Uint8Array) { this.objects.set(key, Uint8Array.from(data)); }
  async delete(key: string) { this.objects.delete(key); }
  list = vi.fn(async (prefix: string, { delimiter, limit = Infinity }: ListOptions = {}) => {
    const objects = [], prefixes = new Set<string>();
    for (const [key, data] of this.objects) if (key.startsWith(prefix)) {
      const position = delimiter ? key.indexOf(delimiter, prefix.length) : -1;
      if (position !== -1) prefixes.add(key.slice(0, position + delimiter!.length));
      else objects.push({ key, size: data.length });
      if (objects.length + prefixes.size >= limit) break;
    }
    return { objects, prefixes: [...prefixes] };
  });
}
afterEach(() => vi.useRealTimers());

it("round-trips a bare repository through the existing object keys without directory markers", async () => {
  const store = new Store(), prefix = "git/repos/legacy", gitdir = "/repo.git";
  const fs = new GitFileSystem(store, prefix, true);
  await git.init({ fs, gitdir, bare: true, defaultBranch: "main" });
  const oid = await git.writeBlob({ fs, gitdir, blob: Buffer.from("old repository\n") });
  expect(store.objects.has(`${prefix}/repo.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`)).toBe(true);
  const reopened = new GitFileSystem(store, prefix, true);
  await reopened.detectLooseObjects(gitdir);
  expect(Buffer.from((await git.readBlob({ fs: reopened, gitdir, oid })).blob).toString()).toBe("old repository\n");
  expect(await reopened.promises.readFile(`${gitdir}/HEAD`, "utf8")).toBe("ref: refs/heads/main\n");
  expect(await reopened.promises.readdir(`${gitdir}/objects`)).toContain(oid.slice(0, 2));
  expect((await reopened.promises.stat(`${gitdir}/objects/${oid.slice(0, 2)}`)).isDirectory()).toBe(true);
  expect([...store.objects.keys()].every((key) => !key.endsWith("/"))).toBe(true);
});

it.each(["/other/repo.git/HEAD", "/repo.git/../../other/HEAD", "/repo.git/objects/../config", "/repo.git/refs\\heads\\main", "/repo.git/HEAD\0"])(
  "refuses filesystem paths outside the repository: %s", async (path) => {
    const store = new Store(), fs = new GitFileSystem(store, "git/repos/one");
    await expect(fs.promises.readFile(path)).rejects.toMatchObject({ code: "EINVAL" });
    await expect(fs.promises.writeFile(path, "corrupt")).rejects.toMatchObject({ code: "EINVAL" });
    await expect(fs.promises.unlink(path)).rejects.toMatchObject({ code: "EINVAL" });
    expect(store.get).not.toHaveBeenCalled(); expect(store.objects.size).toBe(0);
  },
);

it("skips absent loose-object probes, then reads a newly written loose object", async () => {
  const store = new Store(), fs = new GitFileSystem(store, "git/repos/one", true);
  const path = `/repo.git/objects/aa/${"b".repeat(38)}`;
  await fs.detectLooseObjects("/repo.git");
  await expect(fs.promises.readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(store.get).not.toHaveBeenCalled();
  await fs.promises.writeFile(path, "data");
  expect(await fs.promises.readFile(path, "utf8")).toBe("data");
});

it("caches bytes, missing objects, metadata and listings, coalesces reads and expires them", async () => {
  vi.useFakeTimers();
  const store = new Store(), cached = cacheGitObjectStore(store, { maxBytes: 4096, ttlMs: 100 });
  await store.put("repo/HEAD", Buffer.from("main"));
  const read = () => Promise.all([cached.get("repo/HEAD"), cached.get("missing"), cached.head("repo/HEAD"), cached.list("repo/")]);
  await Promise.all([read(), read()]);
  expect(store.get).toHaveBeenCalledTimes(2); expect(store.head).toHaveBeenCalledTimes(1); expect(store.list).toHaveBeenCalledTimes(1);
  await read(); expect(store.get).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(100);
  await read(); expect(store.get).toHaveBeenCalledTimes(4); expect(store.list).toHaveBeenCalledTimes(2);
  await cached.put("missing", Buffer.from("now present"));
  expect(await cached.get("missing")).toEqual(new TextEncoder().encode("now present"));
  await cached.delete("repo/HEAD");
  expect(await cached.get("repo/HEAD")).toBeNull();
  expect((await cached.list("repo/")).objects).toEqual([]);
});

it("bounds cached bytes with LRU eviction and retries storage failures", async () => {
  const store = new Store(), cached = cacheGitObjectStore(store, { maxBytes: 800, ttlMs: 1000 });
  for (const key of ["a", "b", "c"]) await store.put(key, Buffer.alloc(200));
  await cached.get("a"); await cached.get("b"); await cached.get("a"); await cached.get("c");
  store.get.mockClear();
  await cached.get("a"); expect(store.get).not.toHaveBeenCalled();
  await cached.get("b"); expect(store.get).toHaveBeenCalledExactlyOnceWith("b");
  const failure = new Error("B2 unavailable");
  store.get.mockRejectedValueOnce(failure);
  await expect(cached.get("fault")).rejects.toBe(failure);
  expect(await cached.get("fault")).toBeNull();
});

it("does not repopulate the cache with a read that finishes after a write", async () => {
  const store = new Store(), cached = cacheGitObjectStore(store, { maxBytes: 4096, ttlMs: 1000 });
  let complete!: (bytes: Uint8Array) => void;
  store.get.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  const old = cached.get("HEAD");
  await cached.put("HEAD", Buffer.from("new"));
  complete(Buffer.from("old")); await old;
  expect(await cached.get("HEAD")).toEqual(new TextEncoder().encode("new"));
});

it("writes through bytes and metadata while preserving unrelated objects and refreshing listings", async () => {
  const store = new Store(), cached = cacheGitObjectStore(store, { maxBytes: 4096, ttlMs: 1000 });
  const pack = "repo/objects/pack/recv-1.pack", ref = "repo/refs/heads/main";
  await store.put(pack, Uint8Array.of(1, 2));
  await cached.get(pack);
  await cached.head(pack);
  await cached.list("repo/");
  store.get.mockClear(); store.head.mockClear();

  const value = Uint8Array.of(3, 4, 5);
  await cached.put(ref, value);
  value.fill(0);
  expect(await cached.get(ref)).toEqual(Uint8Array.of(3, 4, 5));
  expect(await cached.head(ref)).toEqual({ size: 3 });
  expect((await cached.list("repo/")).objects).toEqual([{ key: pack, size: 2 }, { key: ref, size: 3 }]);

  await cached.delete(ref);
  expect(await cached.get(ref)).toBeNull();
  expect(await cached.head(ref)).toBeNull();
  expect((await cached.list("repo/")).objects).toEqual([{ key: pack, size: 2 }]);
  expect(await cached.get(pack)).toEqual(Uint8Array.of(1, 2));
  expect(await cached.head(pack)).toEqual({ size: 2 });
  expect(store.get).not.toHaveBeenCalled();
  expect(store.head).not.toHaveBeenCalled();
  expect(store.list).toHaveBeenCalledTimes(3);
});

it.each(["put", "delete"] as const)("reloads a %s whose response was lost while retaining other keys", async (operation) => {
  const store = new Store(), cached = cacheGitObjectStore(store, { maxBytes: 4096, ttlMs: 1000 });
  await store.put("pack", Uint8Array.of(1));
  await store.put("HEAD", Uint8Array.of(2));
  const readHead = () => Promise.all([cached.get("HEAD"), cached.head("HEAD"), cached.list("HEAD")]);
  await cached.get("pack");
  await readHead();
  store.get.mockClear(); store.head.mockClear(); store.list.mockClear();

  const gate = Promise.withResolvers<void>(), failure = new Error("B2 response was lost");
  const newValue = Uint8Array.of(3, 4);
  vi.spyOn(store, operation).mockImplementationOnce(async () => {
    await gate.promise;
    if (operation === "put") store.objects.set("HEAD", newValue);
    else store.objects.delete("HEAD");
    throw failure;
  });
  const rejected = expect(operation === "put" ? cached.put("HEAD", newValue) : cached.delete("HEAD")).rejects.toBe(failure);
  try {
    expect(await readHead()).toEqual([Uint8Array.of(2), { size: 1 }, { objects: [{ key: "HEAD", size: 1 }], prefixes: [] }]);
    expect(store.get).toHaveBeenCalledExactlyOnceWith("HEAD");
    expect(store.head).toHaveBeenCalledExactlyOnceWith("HEAD");
    expect(store.list).toHaveBeenCalledOnce();
  } finally { gate.resolve(); }
  await rejected;
  const exists = operation === "put";
  expect(await readHead()).toEqual([exists ? newValue : null, exists ? { size: 2 } : null,
    { objects: exists ? [{ key: "HEAD", size: 2 }] : [], prefixes: [] }]);
  expect(await cached.get("pack")).toEqual(Uint8Array.of(1));
  expect(store.get.mock.calls).toEqual([["HEAD"], ["HEAD"]]);
  expect(store.head).toHaveBeenCalledTimes(2);
  expect(store.list).toHaveBeenCalledTimes(2);
});
