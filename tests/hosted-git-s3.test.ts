import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { S3GitObjectBucket } from "../packages/api/src/git/s3-object-store";
import { verifyCompletedObject } from "../packages/api/src/git/multipart";

const env = {
  BEUTL_GIT_S3_ENDPOINT: "https://s3.us-east-005.backblazeb2.com/",
  BEUTL_GIT_S3_REGION: "us-east-005",
  BEUTL_GIT_S3_BUCKET: "beutl-test",
  BEUTL_GIT_S3_ACCESS_KEY_ID: "test-key",
  BEUTL_GIT_S3_SECRET_ACCESS_KEY: "test-secret",
  BEUTL_GIT_S3_PATH_STYLE: "true",
};
const response = (body: string, headers: Record<string, string> = {}) => new Response(body, {
  status: 200, headers: { "Content-Type": "application/xml", ...headers },
});

describe("Backblaze B2 S3 storage adapter", () => {
  it("constrains the endpoint and pins downloads to an object version", async () => {
    expect(() => new S3GitObjectBucket({ ...env, BEUTL_GIT_S3_ENDPOINT: "http://127.0.0.1/" }))
      .toThrow("not configured");
    const bucket = new S3GitObjectBucket(env, (async () => {
      throw new Error("Presigning must not send a request");
    }) as typeof fetch);
    const put = new URL(await bucket.presignPut("git-lfs/repos/repo/oid", 5, 3600));
    expect(put.origin).toBe("https://s3.us-east-005.backblazeb2.com");
    expect(put.pathname).toBe("/beutl-test/git-lfs/repos/repo/oid");
    expect(put.searchParams.get("X-Amz-Credential")).toContain("/us-east-005/s3/aws4_request");
    expect(put.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/u);
    expect(put.searchParams.get("X-Amz-SignedHeaders")).toContain("content-length");
    expect(put.searchParams.get("X-Amz-SignedHeaders")).toContain("content-type");
    const get = new URL(await bucket.presignGet("git-lfs/repos/repo/oid", "version-1", 3600));
    expect(get.searchParams.get("versionId")).toBe("version-1");
    expect(get.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("uses B2 multipart UploadPart, ListParts, opaque ETags, Complete and Abort", async () => {
    const requests: { method: string; url: URL; body: string; length: string | null }[] = [];
    const fetcher = (async (request: Request) => {
      const url = new URL(request.url);
      const body = request.method === "HEAD" ? "" : await request.text();
      requests.push({ method: request.method, url, body, length: request.headers.get("content-length") });
      if (url.searchParams.has("uploads"))
        return response("<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>");
      if (url.searchParams.has("partNumber"))
        return response("", { ETag: '"opaque-etag"' });
      if (url.searchParams.has("uploadId") && request.method === "GET")
        return response('<ListPartsResult><Part><PartNumber>1</PartNumber><ETag>"opaque-etag"</ETag><Size>4</Size></Part><IsTruncated>false</IsTruncated></ListPartsResult>');
      if (url.searchParams.has("uploadId") && request.method === "POST")
        return response('<CompleteMultipartUploadResult><ETag>"not-a-sha256"</ETag></CompleteMultipartUploadResult>',
          { "x-amz-version-id": "version-1" });
      if (request.method === "HEAD") {
        expect(url.searchParams.get("versionId")).toBe("version-1");
        return new Response(null, { headers: { "Content-Length": "4", "x-amz-version-id": "version-1" } });
      }
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      throw new Error(`Unexpected S3 request: ${request.method} ${url}`);
    }) as typeof fetch;
    const bucket = new S3GitObjectBucket(env, fetcher);
    const upload = await bucket.createMultipartUpload("git-lfs/object");
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode("data")); controller.close();
    } });
    expect(await upload.uploadPart(1, body, 4)).toEqual({ partNumber: 1, etag: '"opaque-etag"' });
    expect(await upload.listParts()).toEqual([{ partNumber: 1, etag: '"opaque-etag"', size: 4 }]);
    expect(await upload.complete([{ partNumber: 1, etag: '"opaque-etag"' }]))
      .toEqual({ size: 4, versionId: "version-1" });
    await upload.abort();
    expect(requests.find((item) => item.url.searchParams.has("partNumber"))?.length).toBe("4");
    expect(requests.find((item) => item.method === "POST" && item.url.searchParams.has("uploadId"))?.body)
      .toContain("&quot;opaque-etag&quot;");
    expect(requests.at(-1)?.method).toBe("DELETE");
  });

  it("deletes version IDs rather than leaving hidden B2 versions", async () => {
    let listed = 0;
    let deletionBody = "";
    const fetcher = (async (request: Request) => {
      const url = new URL(request.url);
      if (url.searchParams.has("versions")) {
        listed++;
        return response(listed === 1
          ? '<ListVersionsResult><Version><Key>git-lfs/item</Key><VersionId>v1</VersionId></Version><Version><Key>git-lfs/item</Key><VersionId>v2</VersionId></Version><DeleteMarker><Key>git-lfs/item</Key><VersionId>marker</VersionId></DeleteMarker><IsTruncated>false</IsTruncated></ListVersionsResult>'
          : '<ListVersionsResult><IsTruncated>false</IsTruncated></ListVersionsResult>');
      }
      if (url.searchParams.has("delete")) {
        deletionBody = await request.text();
        return response("<DeleteResult/>");
      }
      throw new Error(`Unexpected S3 request: ${url}`);
    }) as typeof fetch;
    const bucket = new S3GitObjectBucket(env, fetcher);
    await bucket.deletePrefix("git-lfs/");
    expect(deletionBody).toContain("<VersionId>v1</VersionId>");
    expect(deletionBody).toContain("<VersionId>marker</VersionId>");
    expect(listed).toBe(2);
  });

  it("hashes the requested object version instead of the latest write", async () => {
    const valid = new TextEncoder().encode("valid");
    const oid = createHash("sha256").update(valid).digest("hex");
    const requested: string[] = [];
    const fetcher = (async (request: Request) => {
      const url = new URL(request.url);
      requested.push(url.searchParams.get("versionId") ?? "");
      const body = url.searchParams.get("versionId") === "v1" ? valid : new TextEncoder().encode("wrong");
      return new Response(body, { headers: {
        "content-length": String(body.byteLength), "x-amz-version-id": url.searchParams.get("versionId") ?? "v2",
      } });
    }) as typeof fetch;
    const bucket = new S3GitObjectBucket(env, fetcher);
    expect(await verifyCompletedObject(bucket, "repo", oid, valid.byteLength, "v1", new AbortController().signal))
      .toBe(true);
    expect(requested).toEqual(["v1"]);
    expect(await verifyCompletedObject(bucket, "repo", oid, valid.byteLength, "v2", new AbortController().signal))
      .toBe(false);
  });

  it("stores, lists, heads and reads Git history over signed S3 requests", async () => {
    const key = "git/repos/repo/HEAD";
    const bytes = new TextEncoder().encode("ref: refs/heads/main\n");
    let saved: Uint8Array | undefined;
    const fetcher = (async (request: Request) => {
      const url = new URL(request.url);
      expect(request.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /u);
      if (url.searchParams.get("list-type") === "2") {
        expect(url.searchParams.get("prefix")).toBe("git/repos/repo/");
        return response(`<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>${key}</Key><Size>${bytes.byteLength}</Size></Contents></ListBucketResult>`);
      }
      expect(url.pathname).toBe(`/beutl-test/${key}`);
      if (request.method === "PUT") {
        expect(request.headers.get("content-length")).toBe(String(bytes.byteLength));
        saved = new Uint8Array(await request.arrayBuffer());
        return response("");
      }
      if (request.method === "HEAD") {
        return new Response(null, { headers: {
          "content-length": String(saved?.byteLength), "x-amz-version-id": "v1",
        } });
      }
      if (request.method === "GET") {
        return new Response(saved, { headers: {
          "content-length": String(saved?.byteLength), "x-amz-version-id": "v1",
        } });
      }
      throw new Error(`Unexpected S3 request: ${request.method}`);
    }) as typeof fetch;
    const bucket = new S3GitObjectBucket(env, fetcher);
    await bucket.put(key, bytes);
    expect(saved).toEqual(bytes);
    expect(await bucket.head(key)).toEqual({ size: bytes.byteLength, versionId: "v1" });
    expect(new Uint8Array(await (await bucket.get(key))!.arrayBuffer())).toEqual(bytes);
    expect((await bucket.list({ prefix: "git/repos/repo/", limit: 100 })).objects)
      .toEqual([{ key, size: bytes.byteLength }]);
  });
});
