import { AwsClient } from "aws4fetch";
import { XMLParser } from "fast-xml-parser";
import type { GitMultipartUpload, GitObjectBucket } from "./git-object-store";

export interface GitS3Environment {
  BEUTL_GIT_S3_ENDPOINT?: string;
  BEUTL_GIT_S3_REGION?: string;
  BEUTL_GIT_S3_BUCKET?: string;
  BEUTL_GIT_S3_ACCESS_KEY_ID?: string;
  BEUTL_GIT_S3_SECRET_ACCESS_KEY?: string;
  BEUTL_GIT_S3_PATH_STYLE?: string;
}

const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false });
const asArray = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const escapeXml = (value: string) => value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;")
  .replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
const validSize = (value: string | null) => value !== null && Number.isSafeInteger(Number(value)) && Number(value) >= 0;

async function xml(response: Response): Promise<Record<string, any>> {
  if (!response.body) throw new Error("S3 response has no XML body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 4 * 1024 * 1024) throw new RangeError("S3 XML response is too large");
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return parser.parse(new TextDecoder().decode(bytes)) as Record<string, any>;
}

/** SigV4 S3 object storage for Backblaze B2 and other HTTPS S3 endpoints. */
export class S3GitObjectBucket implements GitObjectBucket {
  private readonly endpoint: URL;
  private readonly bucket: string;
  private readonly client: AwsClient;
  private readonly pathStyle: boolean;

  constructor(env: GitS3Environment, private readonly fetcher: typeof fetch = fetch) {
    let endpoint: URL;
    try { endpoint = new URL(env.BEUTL_GIT_S3_ENDPOINT ?? ""); }
    catch { throw new Error("Hosted Git S3 endpoint is invalid"); }
    const bucket = env.BEUTL_GIT_S3_BUCKET ?? "";
    const region = env.BEUTL_GIT_S3_REGION ?? "";
    if (endpoint.protocol !== "https:" || !endpoint.hostname || endpoint.username || endpoint.password ||
        endpoint.search || endpoint.hash || endpoint.pathname !== "/" ||
        !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket) ||
        !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(region) ||
        !env.BEUTL_GIT_S3_ACCESS_KEY_ID || !env.BEUTL_GIT_S3_SECRET_ACCESS_KEY ||
        (env.BEUTL_GIT_S3_PATH_STYLE !== undefined &&
          env.BEUTL_GIT_S3_PATH_STYLE !== "true" && env.BEUTL_GIT_S3_PATH_STYLE !== "false")) {
      throw new Error("Hosted Git S3 storage is not configured");
    }
    this.endpoint = endpoint;
    this.bucket = bucket;
    this.pathStyle = env.BEUTL_GIT_S3_PATH_STYLE !== "false";
    this.client = new AwsClient({ service: "s3", region,
      accessKeyId: env.BEUTL_GIT_S3_ACCESS_KEY_ID,
      secretAccessKey: env.BEUTL_GIT_S3_SECRET_ACCESS_KEY });
  }

  private url(key?: string, params?: Record<string, string>): URL {
    const url = new URL(this.endpoint);
    if (this.pathStyle) url.pathname = `/${this.bucket}/`;
    else url.hostname = `${this.bucket}.${url.hostname}`;
    if (key) url.pathname += key.split("/").map(encodeURIComponent).join("/");
    for (const [name, value] of Object.entries(params ?? {})) url.searchParams.set(name, value);
    return url;
  }

  private async send(method: string, url: URL, body?: BodyInit, headers?: HeadersInit): Promise<Response> {
    const request = new Request(url, {
      method, headers,
      ...(body === undefined ? {} : { body, duplex: "half" }),
      redirect: "error",
    } as RequestInit & { duplex?: "half" });
    const signed = await this.client.sign(request, { aws: { allHeaders: true } });
    const response = await this.fetcher(signed);
    if (!response.ok && response.status !== 404) {
      const detail = (await response.text()).slice(0, 512);
      throw new Error(`S3 ${method} failed: HTTP ${response.status} ${detail}`);
    }
    return response;
  }

  async get(key: string, versionId?: string) {
    const response = await this.send("GET", this.url(key, versionId ? { versionId } : undefined));
    if (response.status === 404) return null;
    const length = response.headers.get("content-length");
    if (!validSize(length) || !response.body) throw new Error("S3 GET has no valid body length");
    return { size: Number(length), versionId: response.headers.get("x-amz-version-id") ?? undefined,
      body: response.body,
      arrayBuffer: () => response.arrayBuffer() };
  }

  async head(key: string, versionId?: string) {
    const response = await this.send("HEAD", this.url(key, versionId ? { versionId } : undefined));
    if (response.status === 404) return null;
    const length = response.headers.get("content-length");
    if (!validSize(length)) throw new Error("S3 HEAD has no valid length");
    return { size: Number(length), versionId: response.headers.get("x-amz-version-id") ?? undefined };
  }

  async put(key: string, value: Uint8Array) {
    await this.send("PUT", this.url(key), value as Uint8Array<ArrayBuffer>, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(value.byteLength),
      "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD",
    });
  }

  async list({ prefix, delimiter, cursor, limit }: {
    prefix: string; delimiter?: string; cursor?: string; limit: number;
  }) {
    const response = await this.send("GET", this.url(undefined, {
      "list-type": "2", prefix, "max-keys": String(Math.min(Math.max(limit, 1), 1000)),
      ...(delimiter ? { delimiter } : {}),
      ...(cursor ? { "continuation-token": cursor } : {}),
    }));
    const result = (await xml(response)).ListBucketResult;
    if (!result) throw new Error("Invalid S3 ListObjectsV2 result");
    const objects = asArray<{ Key: string; Size: string }>(result.Contents)
      .map((entry) => ({ key: entry.Key, size: Number(entry.Size) }));
    if (objects.some((item) => typeof item.key !== "string" || !Number.isSafeInteger(item.size))) {
      throw new Error("Invalid S3 object listing");
    }
    const truncated = result.IsTruncated === "true";
    if (truncated && !result.NextContinuationToken) throw new Error("S3 listing has no continuation token");
    return { objects, delimitedPrefixes: asArray<{ Prefix: string }>(result.CommonPrefixes)
      .map((item) => item.Prefix), truncated, cursor: result.NextContinuationToken as string | undefined };
  }

  private async versions(prefix: string): Promise<{ key: string; versionId: string }[]> {
    const response = await this.send("GET", this.url(undefined, { versions: "", prefix, "max-keys": "1000" }));
    const result = (await xml(response)).ListVersionsResult;
    if (!result) throw new Error("Invalid S3 ListObjectVersions result");
    // The caller removes this page before requesting the first page again.
    const values = [...asArray<{ Key: string; VersionId: string }>(result.Version),
      ...asArray<{ Key: string; VersionId: string }>(result.DeleteMarker)];
    if (result.IsTruncated === "true" && values.length === 0) throw new Error("S3 version listing did not advance");
    if (values.some((item) => !item.Key || !item.VersionId)) throw new Error("Invalid S3 object version");
    return values.map((item) => ({ key: item.Key, versionId: item.VersionId }));
  }

  private async removeVersions(versions: { key: string; versionId: string }[]): Promise<void> {
    if (!versions.length) return;
    const body = `<Delete><Quiet>true</Quiet>${versions.map(({ key, versionId }) =>
      `<Object><Key>${escapeXml(key)}</Key><VersionId>${escapeXml(versionId)}</VersionId></Object>`).join("")}</Delete>`;
    const response = await this.send("POST", this.url(undefined, { delete: "" }), body,
      { "Content-Type": "application/xml" });
    if (response.status === 204) return;
    const result = (await xml(response)).DeleteResult;
    if (result === undefined || asArray(result.Error).length > 0) {
      throw new Error("S3 object version deletion failed");
    }
  }

  async delete(key: string | string[]): Promise<void> {
    for (const one of Array.isArray(key) ? key : [key]) {
      while (true) {
        const versions = (await this.versions(one)).filter((item) => item.key === one);
        if (!versions.length) break;
        await this.removeVersions(versions);
      }
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    while (true) {
      const versions = await this.versions(prefix);
      if (!versions.length) return;
      await this.removeVersions(versions);
    }
  }

  async createMultipartUpload(key: string): Promise<GitMultipartUpload> {
    const response = await this.send("POST", this.url(key, { uploads: "" }));
    const uploadId = (await xml(response)).InitiateMultipartUploadResult?.UploadId;
    if (typeof uploadId !== "string" || uploadId.length === 0) throw new Error("S3 returned no upload ID");
    return this.resumeMultipartUpload(key, uploadId);
  }

  resumeMultipartUpload(key: string, uploadId: string): GitMultipartUpload {
    if (!uploadId || uploadId.length > 512) throw new Error("Invalid S3 upload ID");
    return {
      uploadId,
      uploadPart: async (partNumber, value, length) => {
        const response = await this.send("PUT", this.url(key, { partNumber: String(partNumber), uploadId }),
          value, { "Content-Length": String(length), "Content-Type": "application/octet-stream",
            "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD" });
        const etag = response.headers.get("etag");
        if (!etag || etag.length > 256) throw new Error("S3 returned no valid part ETag");
        return { partNumber, etag };
      },
      listParts: async () => {
        const parts: { partNumber: number; etag: string; size: number }[] = [];
        let marker = 0;
        while (true) {
          const response = await this.send("GET", this.url(key, { uploadId,
            "max-parts": "1000", ...(marker ? { "part-number-marker": String(marker) } : {}) }));
          const result = (await xml(response)).ListPartsResult;
          if (!result) throw new Error("Invalid S3 ListParts result");
          const page = asArray<{ PartNumber: string; ETag: string; Size: string }>(result.Part)
            .map((part) => ({ partNumber: Number(part.PartNumber), etag: part.ETag, size: Number(part.Size) }));
          if (page.some((part) => !Number.isSafeInteger(part.partNumber) || !Number.isSafeInteger(part.size) || !part.etag)) {
            throw new Error("Invalid S3 multipart part");
          }
          parts.push(...page);
          if (result.IsTruncated !== "true") break;
          const next = Number(result.NextPartNumberMarker);
          if (!Number.isSafeInteger(next) || next <= marker) throw new Error("S3 ListParts did not advance");
          marker = next;
        }
        return parts;
      },
      complete: async (parts) => {
        const body = `<CompleteMultipartUpload>${parts.map(({ partNumber, etag }) =>
          `<Part><PartNumber>${partNumber}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
        const response = await this.send("POST", this.url(key, { uploadId }), body,
          { "Content-Type": "application/xml" });
        // S3 can return a 200 response carrying an XML Error after completion.
        const result = await xml(response);
        if (!result.CompleteMultipartUploadResult || result.Error) throw new Error("S3 multipart completion failed");
        const versionId = response.headers.get("x-amz-version-id");
        if (!versionId) throw new Error("S3 completed object has no version ID");
        const head = await this.head(key, versionId);
        if (!head || head.versionId !== versionId) throw new Error("S3 completed object version is not visible");
        return head;
      },
      abort: async () => { await this.send("DELETE", this.url(key, { uploadId })); },
    };
  }

  private async presign(method: "GET" | "PUT", url: URL, expiresSeconds: number, headers?: HeadersInit): Promise<string> {
    if (!Number.isInteger(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > 7 * 86400) {
      throw new Error("Invalid S3 presigned URL lifetime");
    }
    url.searchParams.set("X-Amz-Expires", String(expiresSeconds));
    const signed = await this.client.sign(new Request(url, { method, headers }),
      { aws: { signQuery: true, allHeaders: true } });
    return signed.url;
  }

  presignPut(key: string, size: number, expiresSeconds: number): Promise<string> {
    return this.presign("PUT", this.url(key), expiresSeconds, {
      "Content-Type": "application/octet-stream", "Content-Length": String(size),
    });
  }

  presignGet(key: string, versionId: string, expiresSeconds: number): Promise<string> {
    if (!versionId) throw new Error("Verified S3 object version is missing");
    return this.presign("GET", this.url(key, { versionId }), expiresSeconds);
  }
}
