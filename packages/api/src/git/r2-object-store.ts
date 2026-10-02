import type { ListOptions, ListResult, ObjectStore } from "git-fs-s3";

// git-fs-s3 reads packs into memory. Keep each stored Git object well below the
// Worker memory limit; media belongs in LFS, not in ordinary Git history.
export const MAX_GIT_OBJECT_BYTES = 16 * 1024 * 1024;
const MAX_LIST_ENTRIES = 10_000;

export interface GitR2Bucket {
  get(key: string): Promise<{
    size: number;
    body: ReadableStream<Uint8Array>;
    arrayBuffer(): Promise<ArrayBuffer>;
  } | null>;
  put(key: string, value: Uint8Array): Promise<unknown>;
  delete(key: string | string[]): Promise<unknown>;
  head(key: string): Promise<{ size: number; checksums?: { sha256?: ArrayBuffer } } | null>;
  list(options: {
    prefix: string;
    delimiter?: string;
    cursor?: string;
    limit: number;
  }): Promise<{
    objects: { key: string; size: number }[];
    delimitedPrefixes?: string[];
    truncated: boolean;
    cursor?: string;
  }>;
  createMultipartUpload(key: string): Promise<GitR2MultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): GitR2MultipartUpload;
}

export interface GitR2MultipartUpload {
  uploadId: string;
  uploadPart(partNumber: number, value: ReadableStream<Uint8Array>): Promise<{ partNumber: number; etag: string }>;
  complete(parts: { partNumber: number; etag: string }[]): Promise<{ size: number }>;
  abort(): Promise<void>;
}

export class R2GitObjectStore implements ObjectStore {
  constructor(private readonly bucket: GitR2Bucket) {}

  async get(key: string): Promise<Uint8Array | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    if (object.size > MAX_GIT_OBJECT_BYTES) {
      throw new RangeError("Git object exceeds the Worker memory limit");
    }
    return new Uint8Array(await object.arrayBuffer());
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    if (data.byteLength > MAX_GIT_OBJECT_BYTES) {
      throw new RangeError("Git object exceeds the Worker memory limit");
    }
    await this.bucket.put(key, data);
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  async head(key: string): Promise<{ size: number } | null> {
    const object = await this.bucket.head(key);
    return object ? { size: object.size } : null;
  }

  async list(prefix: string, options: ListOptions = {}): Promise<ListResult> {
    const objects: ListResult["objects"] = [];
    const prefixes = new Set<string>();
    const limit = Math.min(options.limit ?? MAX_LIST_ENTRIES, MAX_LIST_ENTRIES);
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({
        prefix,
        ...(options.delimiter ? { delimiter: options.delimiter } : {}),
        ...(cursor ? { cursor } : {}),
        limit: Math.min(1000, limit - objects.length - prefixes.size || 1),
      });
      objects.push(...page.objects.map(({ key, size }) => ({ key, size })));
      for (const value of page.delimitedPrefixes ?? []) {
        prefixes.add(
          options.delimiter && !value.endsWith(options.delimiter)
            ? value + options.delimiter
            : value,
        );
      }
      if (objects.length + prefixes.size >= limit) break;
      if (!page.truncated) break;
      if (!page.cursor || page.cursor === cursor) {
        throw new Error("R2 listing did not advance");
      }
      cursor = page.cursor;
    } while (true);

    if (objects.length + prefixes.size >= MAX_LIST_ENTRIES && options.limit === undefined) {
      throw new RangeError("Git repository has too many objects for this Worker");
    }
    return { objects, prefixes: [...prefixes] };
  }
}
