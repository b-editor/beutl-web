import { Buffer } from "node:buffer";
import type { ObjectStore } from "./git-object-store";

function fsError(code: string, path: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}
type Encoding = BufferEncoding | { encoding?: BufferEncoding | null };

/** A bare repository's files map directly to object keys; directories are implicit. */
export class GitFileSystem {
  private readonly directories = new Set(["/", "/repo.git"]);
  private noLooseObjects = false;
  constructor(private readonly store: ObjectStore, private readonly prefix: string,
    private readonly looseObjectHints = false) {}

  private key(path: string): string {
    const clean = path.replace(/\/+$/u, "") || "/";
    if ((clean !== "/" && clean !== "/repo.git" && !clean.startsWith("/repo.git/")) ||
        clean.includes("\\") || clean.includes("\0") || clean.split("/").some((part) => part === "." || part === ".."))
      throw fsError("EINVAL", path);
    return `${this.prefix}${clean === "/" ? "" : clean}`;
  }
  private missingLoose(path: string): boolean {
    return this.noLooseObjects && /^\/repo\.git\/objects\/[0-9a-f]{2}\/[0-9a-f]{38}$/u.test(path);
  }
  private async stat(path: string) {
    const key = this.key(path);
    let size = 0, directory = this.directories.has(path);
    if (this.missingLoose(path)) throw fsError("ENOENT", path);
    if (!directory) {
      const entry = await this.store.head(key);
      if (entry) size = entry.size;
      else {
        const list = await this.store.list(`${key}/`, { limit: 1 });
        if (!list.objects.length && !list.prefixes.length) throw fsError("ENOENT", path);
        directory = true;
      }
    }
    return { size, mode: directory ? 0o40755 : 0o100644, mtimeMs: 0, ctimeMs: 0,
      isFile: () => !directory, isDirectory: () => directory, isSymbolicLink: () => false };
  }

  // isomorphic-git selects this enumerable promise interface instead of callbacks.
  readonly promises = {
    readFile: async (path: string, options?: Encoding): Promise<Uint8Array | string> => {
      const key = this.key(path);
      if (this.missingLoose(path)) throw fsError("ENOENT", path);
      const data = await this.store.get(key);
      if (data === null) throw fsError("ENOENT", path);
      const encoding = typeof options === "string" ? options : options?.encoding;
      // Our object reader only reads these bytes; isomorphic-git makes its own
      // Buffer copy. Avoid duplicating every cached pack in this adapter too.
      return encoding ? Buffer.from(data).toString(encoding) : data;
    },
    writeFile: async (path: string, data: Uint8Array | string, options?: Encoding): Promise<void> => {
      const key = this.key(path);
      const encoding = typeof options === "string" ? options : options?.encoding;
      await this.store.put(key, typeof data === "string" ? Buffer.from(data, encoding ?? "utf8") : data);
      if (/\/objects\/[0-9a-f]{2}\/[0-9a-f]{38}$/u.test(path)) this.noLooseObjects = false;
    },
    unlink: async (path: string): Promise<void> => { await this.store.delete(this.key(path)); },
    readdir: async (path: string): Promise<string[]> => {
      const prefix = `${this.key(path)}/`, listing = await this.store.list(prefix, { delimiter: "/" });
      return [...new Set([...listing.objects.map(({ key }) => key), ...listing.prefixes]
        .map((key) => key.slice(prefix.length).replace(/\/$/u, "")).filter(Boolean))].sort();
    },
    mkdir: async (path: string): Promise<void> => { this.key(path); this.directories.add(path); },
    rmdir: async (path: string): Promise<void> => {
      const listing = await this.store.list(`${this.key(path)}/`, { limit: 1 });
      if (listing.objects.length || listing.prefixes.length) throw fsError("ENOTEMPTY", path);
      this.directories.delete(path);
    },
    stat: (path: string) => this.stat(path),
    lstat: (path: string) => this.stat(path),
    readlink: async (path: string): Promise<string> => { this.key(path); throw fsError("ENOENT", path); },
    symlink: async (_target: string, path: string): Promise<void> => { this.key(path); throw fsError("EPERM", path); },
  };

  /** A request-local hint; the repository queue prevents concurrent writes while it is used. */
  async detectLooseObjects(gitdir: string): Promise<void> {
    if (!this.looseObjectHints) return;
    const prefix = `${this.key(gitdir)}/objects/`, listing = await this.store.list(prefix, { delimiter: "/" });
    this.noLooseObjects = ![...listing.prefixes, ...listing.objects.map(({ key }) => key)]
      .some((key) => /^[0-9a-f]{2}\//u.test(key.slice(prefix.length)));
  }
}
