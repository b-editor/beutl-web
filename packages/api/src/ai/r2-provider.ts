// R2 bucket injection point shared by the standalone Worker and OpenNext.
// Keep this module dependency-free: instrumentation imports it during Worker
// startup, before any API route or AI provider implementation is needed.
const GLOBAL_KEY = "__BEUTL_R2_BUCKET_PROVIDER__";

export type R2BucketLike = {
  put(
    key: string,
    value: ArrayBuffer | ReadableStream | string,
    options?: { httpMetadata?: { contentType?: string } },
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
