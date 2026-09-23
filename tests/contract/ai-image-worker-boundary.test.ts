import { describe, expect, it } from "vitest";
import { sign } from "hono/jwt";
import { fetchImageEdit, type ImageWorkerEnv } from "../../packages/api/src/image-worker";

const ENV: ImageWorkerEnv = {
  BEUTL_DATABASE_HYPERDRIVE: { connectionString: "postgresql://unused:unused@localhost:5432/unused" },
  JWT_SECRET: "image-worker-contract-secret",
  JWT_ISSUER: "beutl-web-image-edit",
  JWT_AUDIENCE: "beutl-ai-images",
};

function request(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://beutl.beditor.net${path}`, {
    method: "POST",
    headers,
    body: "image body stream",
  });
}

describe("isolated image Worker boundary", () => {
  it("exposes only the image edit path", async () => {
    const response = await fetchImageEdit(request("/api/v3/ai/images/generate"), ENV);
    expect(response.status).toBe(404);
  });

  it("rejects an oversized declared body before database configuration", async () => {
    const response = await fetchImageEdit(request("/api/v3/ai/images/edit", {
      "content-length": String(Number.MAX_SAFE_INTEGER),
    }), { BEUTL_DATABASE_HYPERDRIVE: { connectionString: "" } });
    expect(response.status).toBe(413);
  });

  it("verifies bearer identity even when called through a private binding", async () => {
    const response = await fetchImageEdit(request("/api/v3/ai/images/edit"), ENV);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error_code: "authenticationIsRequired" });
  });

  it("accepts the dedicated image token and reaches the existing edit contract", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await sign({
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier": "user-1",
      iss: "beutl-web-image-edit",
      aud: "beutl-ai-images",
      iat: now,
      exp: now + 60,
    }, ENV.JWT_SECRET!, "HS256");
    const response = await fetchImageEdit(request("/api/v3/ai/images/edit", {
      authorization: `Bearer ${token}`,
    }), ENV);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error_code: "invalidRequestBody" });
  });
});
