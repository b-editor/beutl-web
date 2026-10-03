import type { ListOptions, ListResult, ObjectStore } from "git-fs-s3";

// git-fs-s3 reads packs into memory. Keep each stored Git object well below the
// Worker memory limit; media belongs in LFS, not in ordinary Git history.
export const MAX_GIT_OBJECT_BYTES = 16 * 1024 * 1024;
const MAX_LIST_ENTRIES = 10_000;

export interface GitObjectBucket {
  download(key: string, versionId: string, method: "GET" | "HEAD", range?: string, signal?: AbortSignal): Promise<Response>;
  get(key: string, versionId?: string): Promise<{
    size: number;
    versionId?: string;
    body: ReadableStream<Uint8Array>;
    arrayBuffer(): Promise<ArrayBuffer>;
  } | null>;
  getRange?(key: string, versionId: string, start: number, length: number): Promise<{
    size: number; versionId: string; body: ReadableStream<Uint8Array>;
  }>;
  put(key: string, value: Uint8Array): Promise<unknown>;
  delete(key: string | string[]): Promise<unknown>;
  deletePrefix?(prefix: string): Promise<void>;
  pruneVersions?(key: string, keepVersionIds: readonly string[]): Promise<void>;
  pruneGitVersions?(prefix: string): Promise<void>;
  cleanupMultipartUploads?(prefix: string, activeUploadIds: readonly string[], initiatedBefore: number): Promise<void>;
  head(key: string, versionId?: string): Promise<{ size: number; versionId?: string } | null>;
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
  createMultipartUpload(key: string): Promise<GitMultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): GitMultipartUpload;
}

export interface GitMultipartUpload {
  uploadId: string;
  uploadPart(partNumber: number, value: ReadableStream<Uint8Array>, length: number): Promise<{ partNumber: number; etag: string }>;
  listParts(): Promise<{ partNumber: number; etag: string; size: number }[]>;
  complete(parts: { partNumber: number; etag: string }[]): Promise<{ size: number; versionId?: string }>;
  abort(): Promise<void>;
}

export class GitObjectStore implements ObjectStore {
  constructor(private readonly bucket: GitObjectBucket) {}

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
        throw new Error("S3 listing did not advance");
      }
      cursor = page.cursor;
    } while (true);

    if (objects.length + prefixes.size >= MAX_LIST_ENTRIES && options.limit === undefined) {
      throw new RangeError("Git repository has too many objects for this Worker");
    }
    return { objects, prefixes: [...prefixes] };
  }
}
