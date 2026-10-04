import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { S3GitObjectBucket } from "../packages/api/src/git/s3-object-store";
import { createStorageBucket } from "../packages/api/src/storage/bucket-from-env";

const env = {
  BEUTL_S3_ENDPOINT: "https://s3.us-east-005.backblazeb2.com/",
  BEUTL_S3_REGION: "us-east-005",
  BEUTL_S3_BUCKET: "beutl-test",
  BEUTL_S3_ACCESS_KEY_ID: "test-key",
  BEUTL_S3_SECRET_ACCESS_KEY: "test-secret",
  BEUTL_S3_FORCE_PATH_STYLE: "true",
};
const response = (body: string, headers: Record<string, string> = {}) => new Response(body, {
  status: 200, headers: { "Content-Type": "application/xml", ...headers },
});

describe("Backblaze B2 S3 storage adapter", () => {
  it.each([[undefined, true], [" yes ", true], ["false", false]] as const)(
    "uses the same S3 configuration for File/AI and Git/LFS (path style: %s)", async (setting, pathStyle) => {
      const requests: Request[] = [];
      const fetcher = vi.fn(async (request: Request) => {
        requests.push(request);
        return new Response(null, { status: 200 });
      });
      vi.stubGlobal("fetch", fetcher);
      try {
        const shared = { ...env, BEUTL_STORAGE_PROVIDER: "s3", BEUTL_S3_FORCE_PATH_STYLE: setting,
          BEUTL_S3_SESSION_TOKEN: "shared-session" };
        const files = createStorageBucket(shared);
        const git = new S3GitObjectBucket(shared, fetcher as typeof fetch);
        await files.put("file", "content");
        await git.put("git/item", new Uint8Array([1]));
        const base = pathStyle ? `${env.BEUTL_S3_ENDPOINT}${env.BEUTL_S3_BUCKET}/`
          : `https://${env.BEUTL_S3_BUCKET}.s3.us-east-005.backblazeb2.com/`;
        expect(requests.map(request => request.url)).toEqual([`${base}file`, `${base}git/item`]);
        for (const request of requests) {
          expect(request.headers.get("authorization"))
            .toContain("Credential=test-key/");
          expect(request.headers.get("authorization"))
            .toContain("/us-east-005/s3/aws4_request");
          expect(request.headers.get("x-amz-security-token")).toBe("shared-session");
        }
      } finally { vi.unstubAllGlobals(); }
    },
  );

  it("rejects missing-bucket writes while preserving missing reads and idempotent aborts", async () => {
    const bucket = new S3GitObjectBucket(env, (async () =>
      new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 })) as typeof fetch);
    await expect(bucket.put("git/item", new Uint8Array([1]))).rejects.toThrow("S3 PUT failed: HTTP 404");
    await expect(bucket.createMultipartUpload("git-lfs/item")).rejects.toThrow("S3 POST failed: HTTP 404");
    await expect(bucket.resumeMultipartUpload("git-lfs/item", "missing").complete([]))
      .rejects.toThrow("S3 POST failed: HTTP 404");
    await expect(bucket.get("missing")).resolves.toBeNull();
    await expect(bucket.head("missing")).resolves.toBeNull();
    await expect(bucket.resumeMultipartUpload("git-lfs/item", "missing").abort()).resolves.toBeUndefined();
  });

  it("rejects redirects without forwarding the signed request", async () => {
    let requests = 0;
    const bucket = new S3GitObjectBucket(env, (async (request: Request) => {
      requests++;
      expect(request.redirect).toBe("manual");
      return new Response("redirect refused", { status: 302, headers: { Location: "https://another.example/object" } });
    }) as typeof fetch);
    await expect(bucket.head("item")).rejects.toThrow("HTTP 302");
    expect(requests).toBe(1);
  });

  it.each([4, 3, 5])("uses a fixed-length Worker stream and enforces the declared %i-byte part", async (length) => {
    const lengths: number[] = [];
    class FixedLength extends TransformStream<Uint8Array, Uint8Array> {
      constructor(expected: number) {
        let received = 0;
        super({
          transform(chunk, controller) {
            received += chunk.byteLength;
            if (received > expected) throw new Error("too many bytes");
            controller.enqueue(chunk);
          },
          flush() { if (received !== expected) throw new Error("too few bytes"); },
        });
        lengths.push(expected);
      }
    }
    vi.stubGlobal("FixedLengthStream", FixedLength);
    try {
      const bucket = new S3GitObjectBucket(env, (async (request: Request) => {
        expect(request.headers.get("content-length")).toBe(String(length));
        expect(request.headers.get("authorization")).toContain("content-length");
        expect(await request.text()).toBe("data");
        return response("", { ETag: "part-etag" });
      }) as typeof fetch);
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode("data")); controller.close();
      } });
      const upload = bucket.resumeMultipartUpload("git-lfs/item", "upload").uploadPart(1, body, length);
      if (length === 4) await expect(upload).resolves.toEqual({ partNumber: 1, etag: "part-etag" });
      else await expect(upload).rejects.toThrow(length < 4 ? "too many bytes" : "too few bytes");
      expect(lengths).toEqual([length]);
    } finally { vi.unstubAllGlobals(); }
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
        expect(request.headers.get("content-md5"))
          .toBe(createHash("md5").update(deletionBody).digest("base64"));
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

  it("keeps a pinned old LFS version while removing an unreferenced newer write", async () => {
    let remaining = new Set(["pinned", "newer", "marker"]);
    const removed: string[] = [];
    const bucket = new S3GitObjectBucket(env, (async (request: Request) => {
      const url = new URL(request.url);
      if (url.searchParams.has("versions")) {
        const entries = [...remaining].map((version) =>
          `<Version><Key>git-lfs/item</Key><VersionId>${version}</VersionId></Version>`).join("");
        return response(`<ListVersionsResult>${entries}<IsTruncated>false</IsTruncated></ListVersionsResult>`);
      }
      if (url.searchParams.has("delete")) {
        const body = await request.text();
        for (const version of [...remaining]) {
          if (body.includes(`<VersionId>${version}</VersionId>`)) {
            remaining.delete(version); removed.push(version);
          }
        }
        return response("<DeleteResult/>");
      }
      throw new Error(`Unexpected S3 request: ${url}`);
    }) as typeof fetch);
    await bucket.pruneVersions("git-lfs/item", ["pinned"]);
    expect(remaining).toEqual(new Set(["pinned"]));
    expect(removed).toEqual(expect.arrayContaining(["newer", "marker"]));
    expect(removed).not.toContain("pinned");
  });

  it("removes old Git versions before a latest delete marker", async () => {
    const versions = new Set(["old", "marker", "live"]);
    const removed: string[] = [];
    const bucket = new S3GitObjectBucket(env, (async (request: Request) => {
      const url = new URL(request.url);
      if (url.searchParams.has("versions")) {
        const old = versions.has("old")
          ? '<Version><Key>git/repos/r/deleted</Key><VersionId>old</VersionId><IsLatest>false</IsLatest></Version>' : "";
        const marker = versions.has("marker")
          ? '<DeleteMarker><Key>git/repos/r/deleted</Key><VersionId>marker</VersionId><IsLatest>true</IsLatest></DeleteMarker>' : "";
        const live = versions.has("live")
          ? '<Version><Key>git/repos/r/live</Key><VersionId>live</VersionId><IsLatest>true</IsLatest></Version>' : "";
        return response(`<ListVersionsResult>${old}${marker}${live}<IsTruncated>false</IsTruncated></ListVersionsResult>`);
      }
      if (url.searchParams.has("delete")) {
        const body = await request.text();
        for (const version of [...versions]) {
          if (body.includes(`<VersionId>${version}</VersionId>`)) {
            if (version === "marker") expect(versions.has("old")).toBe(false);
            versions.delete(version); removed.push(version);
          }
        }
        return response("<DeleteResult/>");
      }
      throw new Error(`Unexpected S3 request: ${url}`);
    }) as typeof fetch);
    await bucket.pruneGitVersions("git/repos/r/");
    expect(versions).toEqual(new Set(["live"]));
    expect(removed).toEqual(["old", "marker"]);
  });

  it("aborts only stale untracked multipart uploads and retries after an abort failure", async () => {
    const old = "2026-09-25T00:00:00.000Z";
    const fresh = "2026-10-02T00:00:00.000Z";
    const uploads = new Map([ ["orphan", old], ["active", old], ["recent", fresh] ]);
    let failOnce = true;
    const bucket = new S3GitObjectBucket(env, (async (request: Request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.searchParams.has("uploads")) {
        const xmlUploads = [...uploads].map(([id, initiated]) =>
          `<Upload><Key>git-lfs/repos/r/${id}</Key><UploadId>${id}</UploadId><Initiated>${initiated}</Initiated></Upload>`).join("");
        return response(`<ListMultipartUploadsResult>${xmlUploads}<IsTruncated>false</IsTruncated></ListMultipartUploadsResult>`);
      }
      if (request.method === "DELETE") {
        const id = url.searchParams.get("uploadId")!;
        expect(id).toBe("orphan");
        if (failOnce) { failOnce = false; return new Response("temporary", { status: 503 }); }
        uploads.delete(id);
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected S3 request: ${url}`);
    }) as typeof fetch);
    const run = () => bucket.cleanupMultipartUploads("git-lfs/repos/r/", ["active"], Date.parse(fresh));
    await expect(run()).rejects.toThrow("503");
    await run();
    expect([...uploads.keys()]).toEqual(["active", "recent"]);
  });

  it("continues multipart cleanup through pages of protected uploads", async () => {
    const listed: string[] = [];
    let orphan = true;
    const bucket = new S3GitObjectBucket(env, (async (request: Request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.searchParams.has("uploads")) {
        listed.push(url.searchParams.get("key-marker") ?? "first");
        return url.searchParams.has("key-marker")
          ? response(`<ListMultipartUploadsResult>${orphan
            ? '<Upload><Key>git-lfs/repos/r/orphan</Key><UploadId>orphan</UploadId><Initiated>2026-09-20T00:00:00Z</Initiated></Upload>'
            : ""}<IsTruncated>false</IsTruncated></ListMultipartUploadsResult>`)
          : response('<ListMultipartUploadsResult><Upload><Key>git-lfs/repos/r/active</Key><UploadId>active</UploadId><Initiated>2026-09-20T00:00:00Z</Initiated></Upload><IsTruncated>true</IsTruncated><NextKeyMarker>page-2</NextKeyMarker><NextUploadIdMarker>active</NextUploadIdMarker></ListMultipartUploadsResult>');
      }
      if (request.method === "DELETE") {
        expect(url.searchParams.get("uploadId")).toBe("orphan");
        orphan = false;
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected S3 request: ${url}`);
    }) as typeof fetch);
    await bucket.cleanupMultipartUploads("git-lfs/repos/r/", ["active"], Date.parse("2026-10-01"));
    expect(orphan).toBe(false);
    expect(listed).toEqual(["first", "page-2", "first", "page-2"]);
  });

  it("rejects a range from a different version or span", async () => {
    const bucket = new S3GitObjectBucket(env, (async (request: Request) => {
      expect(request.headers.get("range")).toBe("bytes=2-4");
      return new Response("abc", { status: 206, headers: {
        "content-range": "bytes 2-4/10", "content-length": "3", "x-amz-version-id": "wrong",
      } });
    }) as typeof fetch);
    await expect(bucket.getRange("git-lfs/item", "pinned", 2, 3)).rejects.toThrow("pinned object version");
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
