import { AwsClient } from "aws4fetch";
import { XMLParser } from "fast-xml-parser";
import { createHash } from "node:crypto";
import type { GitMultipartUpload, GitObjectBucket } from "./git-object-store";
import { s3BucketOptionsFromEnv } from "../storage/bucket-from-env";
import { knownLengthStream } from "./streams";

export interface GitS3Environment {
  BEUTL_S3_ENDPOINT?: string;
  BEUTL_S3_REGION?: string;
  BEUTL_S3_BUCKET?: string;
  BEUTL_S3_ACCESS_KEY_ID?: string;
  BEUTL_S3_SECRET_ACCESS_KEY?: string;
  BEUTL_S3_FORCE_PATH_STYLE?: string;
  BEUTL_S3_SESSION_TOKEN?: string;
}

const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false });
const asArray = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const escapeXml = (value: string) => value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;")
  .replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
/** S3 checksum headers carry the raw digest in base64; LFS OIDs are its hex form. */
export const sha256Base64 = (hex: string) =>
  btoa(String.fromCharCode(...(hex.match(/../gu) ?? []).map((byte) => parseInt(byte, 16))));
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

  // Workers reject the platform fetch when it is called as this object's
  // method ("Illegal invocation"), so the default calls it without a receiver.
  constructor(env: GitS3Environment,
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {
    const options = s3BucketOptionsFromEnv(env);
    let endpoint: URL;
    try { endpoint = new URL(options.endpoint); }
    catch { throw new Error("Hosted Git S3 endpoint is invalid"); }
    const bucket = options.bucket;
    const region = options.region ?? "";
    if (endpoint.protocol !== "https:" || !endpoint.hostname || endpoint.username || endpoint.password ||
        endpoint.search || endpoint.hash || endpoint.pathname !== "/" ||
        !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket) ||
        !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(region)) {
      throw new Error("Hosted Git S3 storage is not configured");
    }
    this.endpoint = endpoint;
    this.bucket = bucket;
    this.pathStyle = options.forcePathStyle !== false;
    this.client = new AwsClient({ service: "s3", region,
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey, sessionToken: options.sessionToken });
  }

  private url(key?: string, params?: Record<string, string>): URL {
    const url = new URL(this.endpoint);
    if (this.pathStyle) url.pathname = `/${this.bucket}/`;
    else url.hostname = `${this.bucket}.${url.hostname}`;
    if (key) url.pathname += key.split("/").map(encodeURIComponent).join("/");
    for (const [name, value] of Object.entries(params ?? {})) url.searchParams.set(name, value);
    return url;
  }

  private async send(method: string, url: URL, body?: BodyInit, headers?: HeadersInit,
    signal?: AbortSignal, allowed: number[] = []): Promise<Response> {
    const request = new Request(url, {
      method, headers, signal,
      ...(body === undefined ? {} : { body, duplex: "half" }),
      redirect: "manual",
    } as RequestInit & { duplex?: "half" });
    const signed = await this.client.sign(request, { redirect: "manual", aws: { allHeaders: true } });
    const response = await this.fetcher(signed);
    const missingIsExpected = response.status === 404 &&
      (method === "GET" || method === "HEAD" || method === "DELETE");
    if (!response.ok && !missingIsExpected && !allowed.includes(response.status)) {
      const detail = (await response.text()).slice(0, 512);
      throw new Error(`S3 ${method} failed: HTTP ${response.status} ${detail}`);
    }
    return response;
  }

  async download(key: string, versionId: string, method: "GET" | "HEAD", range?: string, signal?: AbortSignal): Promise<Response> {
    if (!versionId) throw new Error("Download requires a pinned B2 version");
    const result = await this.send(method, this.url(key, { versionId }), undefined,
      range ? { Range: range } : undefined, signal, [416]);
    if (result.ok && result.headers.get("x-amz-version-id") !== versionId) {
      await result.body?.cancel();
      throw new Error("B2 returned a different object version");
    }
    return result;
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

  async head(key: string, versionId?: string, { checksum = false }: { checksum?: boolean } = {}) {
    const response = await this.send("HEAD", this.url(key, versionId ? { versionId } : undefined), undefined,
      checksum ? { "x-amz-checksum-mode": "ENABLED" } : undefined);
    if (response.status === 404) return null;
    const length = response.headers.get("content-length");
    if (!validSize(length)) throw new Error("S3 HEAD has no valid length");
    return { size: Number(length), versionId: response.headers.get("x-amz-version-id") ?? undefined,
      ...(checksum ? { checksumSha256: response.headers.get("x-amz-checksum-sha256") ?? undefined } : {}) };
  }
  async presignUpload(key: string, size: number, sha256Hex: string, expiresInSeconds: number) {
    if (!Number.isSafeInteger(size) || size < 0 || !/^[0-9a-f]{64}$/u.test(sha256Hex) ||
        !Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 7 * 24 * 3600)
      throw new Error("Invalid presigned upload");
    // Both headers are signed, so B2 rejects any other length (403) or content (400 BadDigest).
    const signed = await this.client.sign(this.url(key, { "X-Amz-Expires": String(expiresInSeconds) }), {
      method: "PUT", headers: { "Content-Length": String(size), "x-amz-checksum-sha256": sha256Base64(sha256Hex) },
      aws: { signQuery: true, allHeaders: true },
    });
    return signed.url;
  }

  async put(key: string, value: Uint8Array) {
    await this.send("PUT", this.url(key), value as Uint8Array<ArrayBuffer>, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(value.byteLength),
      "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD",
    });
  }

  async putStream(key: string, body: ReadableStream<Uint8Array>, length: number) {
    await this.send("PUT", this.url(key), knownLengthStream(body, length), {
      "Content-Type": "application/octet-stream", "Content-Length": String(length),
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
      { "Content-Type": "application/xml", "Content-MD5": createHash("md5").update(body).digest("base64") });
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

  async pruneVersions(key: string, keepVersionIds: readonly string[]): Promise<void> {
    const keep = new Set(keepVersionIds);
    while (true) {
      const page = (await this.versions(key)).filter((item) => item.key === key);
      const removable = page.filter((item) => !keep.has(item.versionId));
      if (!removable.length) return;
      await this.removeVersions(removable);
    }
  }

  async pruneGitVersions(prefix: string): Promise<void> {
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    let removeLatestMarkers = false;
    while (true) {
      const result = (await xml(await this.send("GET", this.url(undefined, {
        versions: "", prefix, "max-keys": "1000",
        ...(keyMarker ? { "key-marker": keyMarker } : {}),
        ...(versionMarker ? { "version-id-marker": versionMarker } : {}),
      })))).ListVersionsResult;
      if (!result) throw new Error("Invalid S3 ListObjectVersions result");
      const versions = asArray<{ Key: string; VersionId: string; IsLatest: string }>(result.Version)
        .map((item) => ({ ...item, marker: false }));
      const markers = asArray<{ Key: string; VersionId: string; IsLatest: string }>(result.DeleteMarker)
        .map((item) => ({ ...item, marker: true }));
      const page = [...versions, ...markers];
      if (page.some((item) => !item.Key?.startsWith(prefix) || !item.VersionId)) {
        throw new Error("Invalid S3 Git version listing");
      }
      // Remove old versions before the latest delete marker. Otherwise a
      // partial batch failure could reveal an older Git object again.
      const stale = page.filter((item) => item.IsLatest !== "true" ||
        removeLatestMarkers && item.marker)
        .map((item) => ({ key: item.Key, versionId: item.VersionId }));
      if (stale.length) {
        await this.removeVersions(stale);
        keyMarker = undefined;
        versionMarker = undefined;
        continue;
      }
      if (result.IsTruncated !== "true") {
        if (removeLatestMarkers) return;
        removeLatestMarkers = true;
        keyMarker = undefined;
        versionMarker = undefined;
        continue;
      }
      const nextKey = result.NextKeyMarker;
      const nextVersion = result.NextVersionIdMarker;
      if (!nextKey || nextKey === keyMarker && nextVersion === versionMarker) {
        throw new Error("S3 Git version listing did not advance");
      }
      keyMarker = nextKey;
      versionMarker = nextVersion || undefined;
    }
  }

  async cleanupMultipartUploads(prefix: string, activeUploadIds: readonly string[], initiatedBefore: number): Promise<void> {
    const active = new Set(activeUploadIds);
    let keyMarker: string | undefined;
    let uploadMarker: string | undefined;
    while (true) {
      const result = (await xml(await this.send("GET", this.url(undefined, {
        uploads: "", prefix, "max-uploads": "1000",
        ...(keyMarker ? { "key-marker": keyMarker } : {}),
        ...(uploadMarker ? { "upload-id-marker": uploadMarker } : {}),
      })))).ListMultipartUploadsResult;
      if (!result) throw new Error("Invalid S3 ListMultipartUploads result");
      const uploads = asArray<{ Key: string; UploadId: string; Initiated: string }>(result.Upload);
      if (uploads.some((item) => !item.Key?.startsWith(prefix) || !item.UploadId ||
          !Number.isFinite(Date.parse(item.Initiated)))) {
        throw new Error("Invalid S3 multipart upload listing");
      }
      const stale = uploads.filter((item) => !active.has(item.UploadId) &&
        Date.parse(item.Initiated) < initiatedBefore);
      if (stale.length) {
        for (const item of stale) {
          await this.resumeMultipartUpload(item.Key, item.UploadId).abort();
        }
        // Aborting mutates the listing; restarting avoids skipping entries.
        keyMarker = undefined;
        uploadMarker = undefined;
        continue;
      }
      if (result.IsTruncated !== "true") return;
      const nextKey = result.NextKeyMarker;
      const nextUpload = result.NextUploadIdMarker;
      if (!nextKey || !nextUpload || nextKey === keyMarker && nextUpload === uploadMarker) {
        throw new Error("S3 multipart upload listing did not advance");
      }
      keyMarker = nextKey;
      uploadMarker = nextUpload;
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
        if (!Number.isSafeInteger(length) || length < 0) throw new RangeError("Invalid S3 part length");
        // Workers infers the wire length from FixedLengthStream; setting the
        // header alone on an ordinary stream does not prevent chunked encoding.
        const FixedLength = (globalThis as { FixedLengthStream?: new (length: number) =>
          TransformStream<Uint8Array, Uint8Array> }).FixedLengthStream;
        const body = typeof FixedLength === "function" ? value.pipeThrough(new FixedLength(length)) : value;
        const response = await this.send("PUT", this.url(key, { partNumber: String(partNumber), uploadId }),
          body, { "Content-Length": String(length), "Content-Type": "application/octet-stream",
            "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD" });
        const etag = response.headers.get("etag");
        if (!etag || etag.length > 256) throw new Error("S3 returned no valid part ETag");
        return { partNumber, etag };
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

}
