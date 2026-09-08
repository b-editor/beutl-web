import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createS3CompatibleBucket,
  isTerminalMultipartAbortError,
  S3StorageError,
} from "@beutl/api";

type Recorded = {
  method: string;
  url: URL;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  text: () => Promise<string>;
};

const recorded: Recorded[] = [];
let responses: Response[] = [];

function respond(...next: Response[]) {
  responses = next;
}

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  if (!(input instanceof Request)) throw new Error("expected a signed Request");
  const request = input;
  recorded.push({
    method: request.method,
    url: new URL(request.url),
    headers: request.headers,
    body: request.body,
    text: () => request.text(),
  });
  const response = responses.shift();
  if (!response) throw new Error("no response was queued");
  return response;
}

function xml(body: string, init?: ResponseInit): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/xml" },
    ...init,
  });
}

function bucket(overrides: Partial<Parameters<typeof createS3CompatibleBucket>[0]> = {}) {
  return createS3CompatibleBucket({
    endpoint: "https://s3.example.test",
    bucket: "beutl",
    region: "auto",
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
    fetch: fakeFetch as typeof fetch,
    ...overrides,
  });
}

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe("S3 compatible bucket adapter", () => {
  beforeEach(() => {
    recorded.length = 0;
    responses = [];
    vi.restoreAllMocks();
  });

  it("puts an object with a SigV4 signature over an unsigned payload", async () => {
    respond(new Response(null, { status: 200, headers: { etag: '"abc"' } }));
    const result = await bucket().put("ai/image/job-1/object 1.png", new Uint8Array([1, 2, 3]).buffer, {
      httpMetadata: { contentType: "image/png" },
    });

    expect(result).toEqual({ key: "ai/image/job-1/object 1.png", etag: "abc" });
    const [request] = recorded;
    expect(request.method).toBe("PUT");
    expect(request.url.toString()).toBe("https://s3.example.test/beutl/ai/image/job-1/object%201.png");
    expect(request.headers.get("content-type")).toBe("image/png");
    expect(request.headers.get("x-amz-content-sha256")).toBe("UNSIGNED-PAYLOAD");
    expect(request.headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/u,
    );
  });

  it("addresses the bucket as a host when path style is turned off", async () => {
    respond(new Response(null, { status: 200 }));
    await bucket({ forcePathStyle: false }).put("key", "text");
    expect(recorded[0].url.toString()).toBe("https://beutl.s3.example.test/key");
  });

  it("keeps an endpoint path prefix in front of the bucket", async () => {
    respond(new Response(null, { status: 200 }));
    await bucket({ endpoint: "https://gateway.example.test/storage/" }).put("key", "text");
    expect(recorded[0].url.toString()).toBe("https://gateway.example.test/storage/beutl/key");
  });

  it("reads an object as a stream with its size and returns null when absent", async () => {
    respond(
      new Response(new Uint8Array([9, 8, 7]), { status: 200, headers: { "content-length": "3" } }),
      xml("<Error><Code>NoSuchKey</Code></Error>", { status: 404 }),
    );
    const s3 = bucket();
    const present = await s3.get!("present");
    expect(present?.size).toBe(3);
    expect(present?.body).toBeInstanceOf(ReadableStream);
    expect(recorded[0].method).toBe("GET");

    expect(await s3.get!("missing")).toBeNull();
  });

  it("surfaces the service error code on a failed read", async () => {
    respond(xml("<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>", { status: 403 }));
    await expect(bucket().get!("secret")).rejects.toMatchObject({
      name: "S3StorageError",
      code: "AccessDenied",
      status: 403,
      operation: "get",
    });
  });

  it("measures an object with HEAD and treats 404 as absent", async () => {
    respond(
      new Response(null, { status: 200, headers: { "content-length": "42" } }),
      new Response(null, { status: 404 }),
    );
    const s3 = bucket();
    expect(await s3.head!("present")).toEqual({ size: 42 });
    expect(recorded[0].method).toBe("HEAD");
    expect(await s3.head!("missing")).toBeNull();
  });

  it("deletes idempotently and rejects other failures", async () => {
    respond(
      new Response(null, { status: 204 }),
      new Response(null, { status: 404 }),
      xml("<Error><Code>InternalError</Code></Error>", { status: 500 }),
      xml("<Error><Code>InternalError</Code></Error>", { status: 500 }),
      xml("<Error><Code>InternalError</Code></Error>", { status: 500 }),
    );
    const s3 = bucket();
    await expect(s3.delete!("a")).resolves.toBeUndefined();
    await expect(s3.delete!("b")).resolves.toBeUndefined();
    await expect(s3.delete!("c")).rejects.toBeInstanceOf(S3StorageError);
    expect(recorded.map((request) => request.method)).toEqual(["DELETE", "DELETE", "DELETE", "DELETE", "DELETE"]);
  });

  it("retries a buffered request on a transient failure", async () => {
    respond(
      new Response(null, { status: 503 }),
      new Response(null, { status: 200 }),
    );
    await bucket().put("key", new Uint8Array([1]).buffer);
    expect(recorded).toHaveLength(2);
  });

  it("starts a multipart upload and decodes the upload id", async () => {
    respond(xml(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
        "<Bucket>beutl</Bucket><Key>k</Key><UploadId>abc&amp;def.1</UploadId>" +
        "</InitiateMultipartUploadResult>",
    ));
    const created = await bucket().createMultipartUpload!("k", { httpMetadata: { contentType: "video/mp4" } });
    expect(created).toEqual({ uploadId: "abc&def.1" });
    expect(recorded[0].method).toBe("POST");
    expect(recorded[0].url.search).toBe("?uploads");
    expect(recorded[0].headers.get("content-type")).toBe("video/mp4");
  });

  it("streams a part without buffering it and strips the ETag quotes", async () => {
    respond(new Response(null, { status: 200, headers: { etag: '"part-etag"' } }));
    const handle = bucket().resumeMultipartUpload!("k", "up&1");
    const part = await handle.uploadPart(2, stream(new Uint8Array([1, 2, 3, 4])));

    expect(part).toEqual({ partNumber: 2, etag: "part-etag" });
    const [request] = recorded;
    expect(request.method).toBe("PUT");
    expect(request.url.search).toBe("?partNumber=2&uploadId=up%261");
    expect(request.headers.get("x-amz-content-sha256")).toBe("UNSIGNED-PAYLOAD");
    expect(request.body).toBeInstanceOf(ReadableStream);
  });

  it("declares the length of a stream it was told about", async () => {
    respond(
      new Response(null, { status: 200, headers: { etag: '"p"' } }),
      new Response(null, { status: 200 }),
      new Response(null, { status: 200 }),
    );
    const s3 = bucket();
    await s3.resumeMultipartUpload!("k", "up").uploadPart(1, stream(new Uint8Array(4)), { contentLength: 4 });
    await s3.put("k", stream(new Uint8Array(2)), { contentLength: 2, httpMetadata: { contentType: "text/plain" } });
    await s3.put("k", new Uint8Array(8).buffer, { contentLength: 8 });
    expect(recorded[0].headers.get("content-length")).toBe("4");
    expect(recorded[1].headers.get("content-length")).toBe("2");
    expect(recorded[1].headers.get("content-type")).toBe("text/plain");
    // A buffered body already carries its length; the header is left to fetch.
    expect(recorded[2].headers.get("content-length")).toBeNull();
    await expect(
      s3.resumeMultipartUpload!("k", "up").uploadPart(1, stream(new Uint8Array(1)), { contentLength: -1 }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("does not retry a streamed part", async () => {
    respond(new Response(null, { status: 503 }));
    const handle = bucket().resumeMultipartUpload!("k", "up");
    await expect(handle.uploadPart(1, stream(new Uint8Array([1])))).rejects.toMatchObject({ status: 503 });
    expect(recorded).toHaveLength(1);
  });

  it("completes with the ordered part list and measures the joined object", async () => {
    respond(
      xml('<CompleteMultipartUploadResult><Location>x</Location><ETag>"final"</ETag></CompleteMultipartUploadResult>'),
      new Response(null, { status: 200, headers: { "content-length": "1234" } }),
    );
    const handle = bucket().resumeMultipartUpload!("k", "up");
    const joined = await handle.complete([
      { partNumber: 1, etag: "e1" },
      { partNumber: 2, etag: '"e2"' },
    ]);

    expect(joined).toEqual({ size: 1234 });
    const [complete, head] = recorded;
    expect(complete.method).toBe("POST");
    expect(complete.url.search).toBe("?uploadId=up");
    expect(complete.headers.get("content-type")).toBe("application/xml");
    expect(await complete.text()).toBe(
      '<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
        "<Part><PartNumber>1</PartNumber><ETag>&quot;e1&quot;</ETag></Part>" +
        "<Part><PartNumber>2</PartNumber><ETag>&quot;e2&quot;</ETag></Part>" +
        "</CompleteMultipartUpload>",
    );
    expect(head.method).toBe("HEAD");
  });

  it("treats an error document behind a 200 completion as a failure", async () => {
    respond(xml("  <Error><Code>EntityTooSmall</Code><Message>Your proposed upload is smaller than the minimum allowed size</Message></Error>"));
    const handle = bucket().resumeMultipartUpload!("k", "up");
    await expect(handle.complete([{ partNumber: 1, etag: "e1" }])).rejects.toMatchObject({
      name: "S3StorageError",
      code: "EntityTooSmall",
      operation: "completeMultipartUpload",
    });
    expect(recorded).toHaveLength(1);
  });

  it("aborts, and reports a forgotten upload the way the reconcilers expect", async () => {
    respond(
      new Response(null, { status: 204 }),
      xml("<Error><Code>NoSuchUpload</Code><Message>The specified upload does not exist.</Message></Error>", { status: 404 }),
    );
    const handle = bucket().resumeMultipartUpload!("k", "up");
    await expect(handle.abort()).resolves.toBeUndefined();
    expect(recorded[0].method).toBe("DELETE");
    expect(recorded[0].url.search).toBe("?uploadId=up");

    let error: unknown;
    try {
      await handle.abort();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(S3StorageError);
    expect((error as S3StorageError).code).toBe("NoSuchUpload");
    expect(isTerminalMultipartAbortError(error)).toBe(true);
  });

  it("rejects an endpoint that is not an http(s) URL", () => {
    expect(() => bucket({ endpoint: "ftp://files.example.test" })).toThrow(/http\(s\)/u);
  });

  it("refuses a plain http endpoint unless insecure transport is allowed", async () => {
    expect(() => bucket({ endpoint: "http://minio.local:9000" })).toThrow(/not https/u);
    respond(new Response(null, { status: 200 }));
    await bucket({ endpoint: "http://minio.local:9000", allowInsecureHttp: true }).put("k", "v");
    expect(recorded[0].url.toString()).toBe("http://minio.local:9000/beutl/k");
  });

  it("refuses keys with dot segments instead of letting the URL rewrite them", async () => {
    const s3 = bucket();
    await expect(s3.put("archive/../current", "v")).rejects.toThrow(/Unsupported object key/u);
    await expect(s3.head!("./a")).rejects.toThrow(/Unsupported object key/u);
    await expect(s3.get!("a//b")).rejects.toThrow(/Unsupported object key/u);
    expect(recorded).toHaveLength(0);
  });

  it("reports the service error code when HEAD is refused", async () => {
    respond(new Response(null, { status: 403 }));
    await expect(bucket().head!("k")).rejects.toMatchObject({
      name: "S3StorageError",
      operation: "head",
      status: 403,
    });
  });

  it("omits the etag of a put the service did not tag", async () => {
    respond(new Response(null, { status: 200 }));
    expect(await bucket().put("k", "v")).toEqual({ key: "k" });
  });

  it("never repeats a multipart initiation", async () => {
    respond(new Response(null, { status: 503 }));
    await expect(bucket().createMultipartUpload!("k")).rejects.toMatchObject({ status: 503 });
    expect(recorded).toHaveLength(1);
  });

  it("retries a completion whose 200 body carries a transient error", async () => {
    respond(
      xml("<Error><Code>InternalError</Code><Message>We encountered an internal error.</Message></Error>"),
      xml("<CompleteMultipartUploadResult><ETag>\"final\"</ETag></CompleteMultipartUploadResult>"),
      new Response(null, { status: 200, headers: { "content-length": "3" } }),
    );
    const handle = bucket().resumeMultipartUpload!("k", "up");
    expect(await handle.complete([{ partNumber: 1, etag: "e1" }])).toEqual({ size: 3 });
    expect(recorded.filter((request) => request.method === "POST")).toHaveLength(2);
  });
});
