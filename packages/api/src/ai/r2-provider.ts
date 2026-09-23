// Storage bucket injection point shared by the standalone Worker and OpenNext.
// The shape is the R2 binding's; storage/s3-compatible-bucket.ts adapts S3
// compatible services to it, and storage/bucket-from-env.ts picks which one
// the configuration names.
// Keep its startup path dependency-free: instrumentation imports it before any
// API route. The Cron-only scope loads async_hooks on demand.
const GLOBAL_KEY = "__BEUTL_R2_BUCKET_PROVIDER__";
const SCOPE_KEY = "__BEUTL_R2_BUCKET_PROVIDER_SCOPE__";

/**
 * A stream body must reach the service with a known length: S3 compatible
 * services reject chunked uploads, and R2 refuses a stream of unknown length.
 * workerd carries the length of an incoming request body along; anywhere
 * else, pass `contentLength` with the stream.
 */
export type StorageStreamOptions = { contentLength?: number };

export type R2BucketLike = {
  put(
    key: string,
    value: ArrayBuffer | ReadableStream | string,
    options?: { httpMetadata?: { contentType?: string } } & StorageStreamOptions,
  ): Promise<unknown>;
  get?(key: string): Promise<{
    body?: ReadableStream<Uint8Array>;
    arrayBuffer?: () => Promise<ArrayBuffer>;
    size?: number;
  } | null>;
  delete?(key: string): Promise<unknown>;
  head?(key: string): Promise<{ size?: number } | null>;
  createMultipartUpload?(
    key: string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<{ uploadId: string }>;
  resumeMultipartUpload?(
    key: string,
    uploadId: string,
  ): {
    uploadPart(
      partNumber: number,
      value: ReadableStream<Uint8Array>,
      options?: StorageStreamOptions,
    ): Promise<{ partNumber: number; etag: string }>;
    complete(
      parts: { partNumber: number; etag: string }[],
    ): Promise<{ size: number }>;
    abort(): Promise<void>;
  };
};

type R2BucketProvider = () => R2BucketLike;

async function providerScope() {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const global = globalThis as Record<string, unknown>;
  return (global[SCOPE_KEY] ??= new AsyncLocalStorage<R2BucketProvider>()) as InstanceType<typeof AsyncLocalStorage<R2BucketProvider>>;
}

/** Bind a bucket to one scheduled invocation without changing concurrent requests. */
export async function runWithR2BucketProvider<T>(fn: R2BucketProvider, callback: () => Promise<T>): Promise<T> {
  return (await providerScope()).run(fn, callback);
}

export function setR2BucketProvider(fn: R2BucketProvider): void {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = fn;
}

export function getR2Bucket(): R2BucketLike {
  const global = globalThis as Record<string, unknown>;
  const scope = global[SCOPE_KEY] as { getStore(): R2BucketProvider | undefined } | undefined;
  const provider = (scope?.getStore() ?? global[GLOBAL_KEY]) as
    | R2BucketProvider
    | undefined;
  if (!provider) {
    throw new Error(
      "R2 bucket provider is not set. Call setR2BucketProvider() before using AI storage.",
    );
  }
  return provider();
}
