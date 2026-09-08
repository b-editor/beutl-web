// S3 互換ストレージ (MinIO / AWS S3 / R2 の S3 API など) を R2 バインディングと
// 同じ形 (R2BucketLike) で扱うためのアダプタ。署名は aws4fetch (SigV4) に任せ、
// 本文はハッシュせず UNSIGNED-PAYLOAD で送るので、パートのストリームを
// メモリに載せずにそのまま流せる。
import { AwsClient } from "aws4fetch";
import type { R2BucketLike, StorageStreamOptions } from "../ai/r2-provider";

export type S3CompatibleBucketOptions = {
  /** `https://host[:port][/prefix]` 形式のエンドポイント。 */
  endpoint: string;
  bucket: string;
  /** 署名に使うリージョン。R2 と MinIO は `auto` を受け付ける。 */
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** `https://endpoint/bucket/key` (既定) か `https://bucket.endpoint/key` か。 */
  forcePathStyle?: boolean;
  fetch?: typeof globalThis.fetch;
};

export class S3StorageError extends Error {
  readonly operation: string;
  readonly status: number;
  readonly code: string | undefined;
  readonly key: string;

  constructor({
    operation,
    status,
    code,
    key,
    detail,
  }: {
    operation: string;
    status: number;
    code?: string;
    key: string;
    detail?: string;
  }) {
    const parts = [`S3 ${operation} of ${key} failed with HTTP ${status}`];
    if (code) parts.push(code);
    if (detail) parts.push(detail);
    super(parts.join(": "));
    this.name = "S3StorageError";
    this.operation = operation;
    this.status = status;
    this.code = code;
    this.key = key;
  }
}

const DEFAULT_REGION = "auto";
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MILLISECONDS = 100;
const MAX_ERROR_BODY_BYTES = 64 * 1024;

type BucketValue = ArrayBuffer | ReadableStream | string;

type MultipartHandle = ReturnType<
  NonNullable<R2BucketLike["resumeMultipartUpload"]>
>;

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, "");
}

function encodeObjectKey(key: string): string {
  if (key.length === 0) throw new TypeError("An object key must not be empty");
  return key.split("/").map(encodeURIComponent).join("/");
}

function decodeXmlEntities(value: string): string {
  return value.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/gu,
    (_match, entity: string) => {
      switch (entity) {
        case "amp":
          return "&";
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "quot":
          return '"';
        case "apos":
          return "'";
        default:
          return String.fromCodePoint(
            entity.startsWith("#x")
              ? Number.parseInt(entity.slice(2), 16)
              : Number.parseInt(entity.slice(1), 10),
          );
      }
    },
  );
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

function xmlText(xml: string, tag: string): string | undefined {
  const match = new RegExp(
    `<(?:[A-Za-z0-9_-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_-]+:)?${tag}>`,
    "u",
  ).exec(xml);
  return match ? decodeXmlEntities(match[1].trim()) : undefined;
}

function hasXmlElement(xml: string, tag: string): boolean {
  return new RegExp(`<(?:[A-Za-z0-9_-]+:)?${tag}(?:[\\s>/]|$)`, "u").test(xml);
}

function stripEtagQuotes(etag: string): string {
  const trimmed = etag.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2
    ? trimmed.slice(1, -1)
    : trimmed;
}

function contentLengthOf(response: Response): number | undefined {
  const header = response.headers.get("content-length");
  if (header === null) return undefined;
  const size = Number(header);
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
}

async function readErrorBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    if (total >= MAX_ERROR_BODY_BYTES) {
      await reader.cancel("error body limit exceeded");
    }
  } catch {
    // A truncated error body still leaves the HTTP status to report.
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(
    combined.subarray(0, MAX_ERROR_BODY_BYTES),
  );
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

// workerd exposes FixedLengthStream, whose length it turns into Content-Length
// on the outgoing request. Elsewhere (Node, for `next dev` and tests) fetch
// sends a stream chunked unless the header is given explicitly.
type FixedLengthStreamConstructor = new (
  length: number,
) => TransformStream<Uint8Array, Uint8Array>;

function withKnownLength(
  value: BucketValue,
  contentLength: number | undefined,
): { body: BucketValue; headers: Record<string, string> } {
  if (!(value instanceof ReadableStream) || contentLength === undefined) {
    return { body: value, headers: {} };
  }
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    throw new RangeError(`Invalid stream content length: ${contentLength}`);
  }
  const FixedLength = (globalThis as { FixedLengthStream?: FixedLengthStreamConstructor })
    .FixedLengthStream;
  if (typeof FixedLength === "function") {
    return {
      body: value.pipeThrough(new FixedLength(contentLength)),
      headers: {},
    };
  }
  return { body: value, headers: { "content-length": String(contentLength) } };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createS3CompatibleBucket(
  options: S3CompatibleBucketOptions,
): R2BucketLike {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new TypeError(
      `The S3 endpoint must be an http(s) URL, received ${options.endpoint}`,
    );
  }
  if (options.bucket.length === 0 || options.bucket.includes("/")) {
    throw new TypeError(`Invalid S3 bucket name: ${options.bucket}`);
  }
  const bucketName = options.bucket;
  const forcePathStyle = options.forcePathStyle ?? true;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const client = new AwsClient({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    sessionToken: options.sessionToken,
    service: "s3",
    region: options.region ?? DEFAULT_REGION,
  });

  function objectUrl(key: string, query?: string): URL {
    const url = new URL(endpoint.toString());
    const prefix = trimTrailingSlashes(url.pathname);
    if (forcePathStyle) {
      url.pathname = `${prefix}/${encodeURIComponent(bucketName)}/${encodeObjectKey(key)}`;
    } else {
      url.hostname = `${bucketName}.${url.hostname}`;
      url.pathname = `${prefix}/${encodeObjectKey(key)}`;
    }
    url.search = query ?? "";
    return url;
  }

  async function failure(
    operation: string,
    key: string,
    response: Response,
  ): Promise<S3StorageError> {
    const body = await readErrorBody(response);
    return new S3StorageError({
      operation,
      key,
      status: response.status,
      code: xmlText(body, "Code"),
      detail: xmlText(body, "Message"),
    });
  }

  async function send({
    method,
    url,
    headers,
    body,
  }: {
    method: string;
    url: URL;
    headers?: Record<string, string>;
    body?: BucketValue;
  }): Promise<Response> {
    // A stream can be sent once, so only buffered bodies get another attempt.
    const attempts =
      body instanceof ReadableStream ? 1 : RETRY_ATTEMPTS;
    for (let attempt = 1; ; attempt++) {
      const request = await client.sign(url.toString(), {
        method,
        headers,
        body,
      });
      let response: Response;
      try {
        response = await fetchImpl(request);
      } catch (error) {
        if (attempt >= attempts) throw error;
        await sleep(RETRY_BASE_MILLISECONDS * 2 ** (attempt - 1) * Math.random());
        continue;
      }
      if (attempt < attempts && isRetryableStatus(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        await sleep(RETRY_BASE_MILLISECONDS * 2 ** (attempt - 1) * Math.random());
        continue;
      }
      return response;
    }
  }

  async function head(key: string): Promise<{ size?: number } | null> {
    const response = await send({
      method: "HEAD",
      url: objectUrl(key),
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new S3StorageError({ operation: "head", key, status: response.status });
    }
    return { size: contentLengthOf(response) };
  }

  function resumeMultipartUpload(key: string, uploadId: string): MultipartHandle {
    const query = `?uploadId=${encodeURIComponent(uploadId)}`;
    return {
      async uploadPart(partNumber, value, partOptions?: StorageStreamOptions) {
        if (!Number.isSafeInteger(partNumber) || partNumber < 1) {
          throw new RangeError(`Invalid multipart part number: ${partNumber}`);
        }
        const sized = withKnownLength(value, partOptions?.contentLength);
        const response = await send({
          method: "PUT",
          url: objectUrl(key, `?partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}`),
          headers: sized.headers,
          body: sized.body,
        });
        if (!response.ok) throw await failure("uploadPart", key, response);
        await response.body?.cancel().catch(() => undefined);
        const etag = response.headers.get("etag");
        if (!etag) {
          throw new S3StorageError({
            operation: "uploadPart",
            key,
            status: response.status,
            detail: "the response carried no ETag",
          });
        }
        return { partNumber, etag: stripEtagQuotes(etag) };
      },
      async complete(parts) {
        const body =
          '<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
          parts
            .map(
              (part) =>
                `<Part><PartNumber>${part.partNumber}</PartNumber>` +
                `<ETag>${escapeXml(`"${stripEtagQuotes(part.etag)}"`)}</ETag></Part>`,
            )
            .join("") +
          "</CompleteMultipartUpload>";
        const response = await send({
          method: "POST",
          url: objectUrl(key, query),
          headers: { "content-type": "application/xml" },
          body,
        });
        if (!response.ok) {
          throw await failure("completeMultipartUpload", key, response);
        }
        // S3 は結合に時間がかかると 200 を返した後で本文に <Error> を書く。
        const text = await response.text();
        if (hasXmlElement(text, "Error")) {
          throw new S3StorageError({
            operation: "completeMultipartUpload",
            key,
            status: response.status,
            code: xmlText(text, "Code"),
            detail: xmlText(text, "Message"),
          });
        }
        if (!hasXmlElement(text, "CompleteMultipartUploadResult")) {
          throw new S3StorageError({
            operation: "completeMultipartUpload",
            key,
            status: response.status,
            detail: "the response was not a CompleteMultipartUploadResult",
          });
        }
        // 結合結果はサイズを返さないので、オブジェクトを見に行って測る。
        const joined = await head(key);
        if (!joined || typeof joined.size !== "number") {
          throw new S3StorageError({
            operation: "completeMultipartUpload",
            key,
            status: response.status,
            detail: "the joined object could not be measured",
          });
        }
        return { size: joined.size };
      },
      async abort() {
        const response = await send({
          method: "DELETE",
          url: objectUrl(key, query),
        });
        if (response.status === 204 || response.status === 200) {
          await response.body?.cancel().catch(() => undefined);
          return;
        }
        throw await failure("abortMultipartUpload", key, response);
      },
    };
  }

  return {
    async put(key, value, putOptions) {
      const contentType = putOptions?.httpMetadata?.contentType;
      const sized = withKnownLength(value, putOptions?.contentLength);
      const response = await send({
        method: "PUT",
        url: objectUrl(key),
        headers: {
          ...sized.headers,
          ...(contentType ? { "content-type": contentType } : {}),
        },
        body: sized.body,
      });
      if (!response.ok) throw await failure("put", key, response);
      await response.body?.cancel().catch(() => undefined);
      return { key, etag: stripEtagQuotes(response.headers.get("etag") ?? "") };
    },
    async get(key) {
      const response = await send({
        method: "GET",
        url: objectUrl(key),
      });
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      if (!response.ok) throw await failure("get", key, response);
      return {
        body: response.body ?? undefined,
        size: contentLengthOf(response),
        arrayBuffer: () => response.arrayBuffer(),
      };
    },
    async delete(key) {
      const response = await send({
        method: "DELETE",
        url: objectUrl(key),
      });
      // R2 と同じく、無いものを消しても成功として扱う。
      if (response.ok || response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      throw await failure("delete", key, response);
    },
    head,
    async createMultipartUpload(key, createOptions) {
      const contentType = createOptions?.httpMetadata?.contentType;
      const response = await send({
        method: "POST",
        url: objectUrl(key, "?uploads"),
        headers: contentType ? { "content-type": contentType } : undefined,
      });
      if (!response.ok) throw await failure("createMultipartUpload", key, response);
      const text = await response.text();
      const uploadId = xmlText(text, "UploadId");
      if (!uploadId) {
        throw new S3StorageError({
          operation: "createMultipartUpload",
          key,
          status: response.status,
          detail: "the response carried no UploadId",
        });
      }
      return { uploadId };
    },
    resumeMultipartUpload,
  };
}
