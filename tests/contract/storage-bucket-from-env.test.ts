import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configuredStorageProviders,
  createStorageBucket,
  resolveStorageBucket,
  storageProviderOf,
} from "@beutl/api";

const binding = { put: vi.fn(), get: vi.fn(), delete: vi.fn(), head: vi.fn() };

const s3Env = {
  BEUTL_STORAGE_PROVIDER: "s3",
  BEUTL_S3_ENDPOINT: "https://s3.example.test",
  BEUTL_S3_BUCKET: "beutl",
  BEUTL_S3_ACCESS_KEY_ID: "AKIAEXAMPLE",
  BEUTL_S3_SECRET_ACCESS_KEY: "secret",
};

describe("choosing the storage provider from the environment", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    binding.put.mockReset();
    binding.get.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses the R2 binding when nothing else is configured", () => {
    expect(storageProviderOf({})).toBe("r2");
    expect(createStorageBucket({ BEUTL_R2_BUCKET: binding })).toBe(binding);
  });

  it("explains a missing R2 binding instead of falling back", () => {
    expect(() => createStorageBucket({})).toThrow(/BEUTL_R2_BUCKET binding not found/u);
  });

  it("rejects an unknown provider name", () => {
    expect(() => createStorageBucket({ BEUTL_STORAGE_PROVIDER: "gcs", BEUTL_R2_BUCKET: binding }))
      .toThrow(/BEUTL_STORAGE_PROVIDER must be one of r2, s3/u);
  });

  it("names every S3 value that is missing", () => {
    expect(() => createStorageBucket({ BEUTL_STORAGE_PROVIDER: "s3" }))
      .toThrow(/BEUTL_S3_ENDPOINT is required for S3 compatible storage/u);
    expect(() => createStorageBucket({ ...s3Env, BEUTL_S3_SECRET_ACCESS_KEY: "  " }))
      .toThrow(/BEUTL_S3_SECRET_ACCESS_KEY is required/u);
    expect(() => createStorageBucket({ ...s3Env, BEUTL_S3_FORCE_PATH_STYLE: "maybe" }))
      .toThrow(/BEUTL_S3_FORCE_PATH_STYLE must be true or false/u);
  });

  it("talks to the configured S3 endpoint and ignores the R2 binding", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const bucket = createStorageBucket({ ...s3Env, BEUTL_R2_BUCKET: binding });
    expect(bucket).not.toBe(binding);

    await bucket.put("k", "v");
    expect(binding.put).not.toHaveBeenCalled();
    const request = fetchMock.mock.calls[0][0] as unknown as Request;
    expect(request.url).toBe("https://s3.example.test/beutl/k");
    expect(request.headers.get("authorization")).toMatch(/\/auto\/s3\/aws4_request/u);
  });

  it("falls back to process.env for values the binding env lacks", () => {
    vi.stubEnv("BEUTL_STORAGE_PROVIDER", "s3");
    vi.stubEnv("BEUTL_S3_ENDPOINT", s3Env.BEUTL_S3_ENDPOINT);
    vi.stubEnv("BEUTL_S3_BUCKET", s3Env.BEUTL_S3_BUCKET);
    vi.stubEnv("BEUTL_S3_ACCESS_KEY_ID", s3Env.BEUTL_S3_ACCESS_KEY_ID);
    vi.stubEnv("BEUTL_S3_SECRET_ACCESS_KEY", s3Env.BEUTL_S3_SECRET_ACCESS_KEY);
    expect(storageProviderOf({})).toBe("s3");
    expect(() => createStorageBucket({})).not.toThrow();
  });

  it("prefers the binding env over process.env", () => {
    vi.stubEnv("BEUTL_STORAGE_PROVIDER", "s3");
    expect(storageProviderOf({ BEUTL_STORAGE_PROVIDER: "r2" })).toBe("r2");
  });

  it("keeps reading from R2 after new objects move to S3", async () => {
    const fetchMock = vi.fn(async (request: Request) =>
      new Response(null, { status: request.method === "GET" ? 404 : 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    binding.get.mockResolvedValueOnce({ size: 5 });
    const env = { ...s3Env, BEUTL_R2_BUCKET: binding };
    expect(configuredStorageProviders(env)).toEqual(["s3", "r2"]);

    const bucket = createStorageBucket(env);
    expect(await bucket.get!("old-key")).toEqual({ size: 5 });
    expect((fetchMock.mock.calls[0][0] as unknown as Request).url).toBe("https://s3.example.test/beutl/old-key");
    expect(binding.get).toHaveBeenCalledWith("old-key");

    await bucket.put("new-key", "v");
    expect(binding.put).not.toHaveBeenCalled();
  });

  it("keeps reading from S3 after new objects move back to R2", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200, headers: { "content-length": "3" } }));
    vi.stubGlobal("fetch", fetchMock);
    const env = { ...s3Env, BEUTL_STORAGE_PROVIDER: "r2", BEUTL_R2_BUCKET: binding };
    expect(configuredStorageProviders(env)).toEqual(["r2", "s3"]);

    const bucket = createStorageBucket(env);
    binding.get.mockResolvedValueOnce(null);
    expect(await bucket.get!("s3-key")).toMatchObject({ size: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the primary alone when the other provider is absent", () => {
    expect(configuredStorageProviders({ BEUTL_R2_BUCKET: binding })).toEqual(["r2"]);
    expect(configuredStorageProviders(s3Env)).toEqual(["s3"]);
    expect(createStorageBucket({ BEUTL_R2_BUCKET: binding })).toBe(binding);
  });

  it("refuses a half-configured fallback rather than skipping it", () => {
    expect(() => createStorageBucket({ BEUTL_R2_BUCKET: binding, BEUTL_S3_ENDPOINT: "https://s3.example.test" }))
      .toThrow(/BEUTL_S3_BUCKET is required/u);
  });

  it("builds one bucket per env object", () => {
    const env = { ...s3Env };
    const first = resolveStorageBucket(env);
    expect(resolveStorageBucket(env)).toBe(first);
    expect(resolveStorageBucket({ ...s3Env })).not.toBe(first);
  });
});
