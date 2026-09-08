// Storage bucket injection point shared by the standalone Worker and OpenNext.
// The shape is the R2 binding's; storage/s3-compatible-bucket.ts adapts S3
// compatible services to it, and storage/bucket-from-env.ts picks which one
// the configuration names.
// Keep this module dependency-free: instrumentation imports it during Worker
// startup, before any API route or AI provider implementation is needed.
const GLOBAL_KEY = "__BEUTL_R2_BUCKET_PROVIDER__";

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

export function setR2BucketProvider(fn: R2BucketProvider): void {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = fn;
}

export function getR2Bucket(): R2BucketLike {
  const provider = (globalThis as Record<string, unknown>)[GLOBAL_KEY] as
    | R2BucketProvider
    | undefined;
  if (!provider) {
    throw new Error(
      "R2 bucket provider is not set. Call setR2BucketProvider() before using AI storage.",
    );
  }
  return provider();
}
