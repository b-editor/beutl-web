import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeOAuthIssuer, nativeOAuthResource } from "@beutl/core";
import worker from "../../apps/nuget-server/src/index";

afterEach(() => vi.unstubAllEnvs());

describe("NuGet Worker OAuth configuration", () => {
  it.each([
    { authUrl: undefined, origin: "https://beutl.beditor.net" },
    { authUrl: "https://auth.example.test/", origin: "https://auth.example.test" },
  ])("uses the Web issuer and resource with BETTER_AUTH_URL=$authUrl", async ({ authUrl, origin }) => {
    vi.stubEnv("PUBLIC_ORIGIN", "");
    vi.stubEnv("BETTER_AUTH_URL", "");
    vi.stubEnv("NUGET_DOWNLOAD_SECRET", "");
    const response = await worker.fetch(
      new Request("https://nuget.beditor.net/v3/index.json"),
      {
        BEUTL_DATABASE_HYPERDRIVE: { connectionString: "postgresql://root@127.0.0.1/unused" },
        BEUTL_R2_BUCKET: { get: vi.fn(), put: vi.fn() },
        NUGET_DOWNLOAD_SECRET: "test-download-secret",
        NUGET_PUBLIC_ORIGIN: "https://nuget.beditor.net",
        PUBLIC_ORIGIN: "https://beutl.beditor.net",
        BETTER_AUTH_URL: authUrl,
      },
      { waitUntil: vi.fn() },
    );

    expect(response.status).toBe(200);
    expect(nativeOAuthIssuer()).toBe(`${origin}/api/auth`);
    expect(nativeOAuthResource()).toBe(`${origin}/api`);
  });
});
