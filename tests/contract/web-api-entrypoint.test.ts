import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { sign } from "hono/jwt";
import { MAX_API_JSON_REQUEST_BYTES } from "@beutl/core";

const mocks = vi.hoisted(() => ({
  next: vi.fn(async () => new Response("Next page")),
  db: {} as any,
}));
vi.mock("../../apps/web/.open-next/worker.js", () => ({
  default: { fetch: mocks.next },
  DOQueueHandler: class {}, DOShardedTagCache: class {}, BucketCachePurge: class {},
}));
vi.mock("@prisma/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@prisma/client")>(),
  PrismaClient: class { constructor() { return mocks.db; } },
}));
import web, { GitRepositoryDurableObject } from "../../apps/web/worker.js";
import apiRuntime, { type Env } from "../../packages/api/src/runtime";
import { basicCredential, gitAccessTokenDelegate, gitAccessTokenFixture } from "../stubs/git-access-tokens";

const repoId = "11111111-1111-4111-8111-111111111111";
const repo = { id: repoId, ownerId: "owner", name: "demo", deletedAt: null,
  createdAt: new Date(), updatedAt: new Date() };
const gitFetch = vi.fn(async (request: Request) => new Response(await request.text()));
const env = {
  BEUTL_DATABASE_HYPERDRIVE: { connectionString: "postgres://entrypoint-test" },
  JWT_SECRET: "web-entrypoint-test-secret", JWT_ISSUER: "", JWT_AUDIENCE: "",
  PUBLIC_ORIGIN: "https://beutl.beditor.net", BEUTL_GIT_ENABLED: "true",
  BEUTL_S3_ENDPOINT: "https://s3.example.test", BEUTL_S3_REGION: "test",
  BEUTL_S3_BUCKET: "git", BEUTL_S3_ACCESS_KEY_ID: "test",
  BEUTL_S3_SECRET_ACCESS_KEY: "test",
  BEUTL_GIT_REPOSITORIES: { idFromName: (name: string) => name, get: () => ({ fetch: gitFetch }) },
} satisfies Env;

function context() {
  const pending: Promise<unknown>[] = [];
  return { pending, waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    passThroughOnException() {}, props: {} };
}
async function authorization() {
  return `Bearer ${await sign({
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier": "owner",
    exp: Math.floor(Date.now() / 1000) + 300,
  }, env.JWT_SECRET, "HS256")}`;
}

describe("public Web Worker API entrypoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.db = {
      $disconnect: vi.fn(async () => undefined),
      $transaction: async (work: (db: unknown) => unknown) => work(mocks.db),
      user: { update: vi.fn(async () => ({ id: "owner" })) },
      gitRepository: {
        findUnique: vi.fn(async () => null), count: vi.fn(async () => 0),
        create: vi.fn(async () => repo), findFirst: vi.fn(async () => repo),
      },
    };
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string") vi.stubEnv(key, value);
    }
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("creates a repository through the deployed Web entrypoint", async () => {
    const ctx = context();
    const response = await web.fetch(new Request(`${env.PUBLIC_ORIGIN}/api/v3/repos`, {
      method: "POST", headers: { authorization: await authorization(), "content-type": "application/json" },
      body: JSON.stringify({ name: "demo", ownerId: "owner", creationId: repoId }),
    }), env, ctx);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ id: repoId, name: "demo",
      url: `${env.PUBLIC_ORIGIN}/api/v3/git/${repoId}.git` });
    expect(mocks.db.gitRepository.create).toHaveBeenCalled();
    expect(mocks.next).not.toHaveBeenCalled();
    await Promise.all(ctx.pending);
    expect(mocks.db.$disconnect).toHaveBeenCalledTimes(1);
  });

  it("keeps unauthenticated repository creation protected", async () => {
    const response = await web.fetch(new Request(`${env.PUBLIC_ORIGIN}/api/v3/repos`, {
      method: "POST", body: "{}",
    }), env, context());
    expect(response.status).toBe(401);
    expect(mocks.db.gitRepository.create).not.toHaveBeenCalled();
    expect(mocks.next).not.toHaveBeenCalled();
  });

  it("streams authenticated Git bodies directly and preserves cancellation", async () => {
    const { token, row } = await gitAccessTokenFixture({ repoId });
    mocks.db.gitAccessToken = gitAccessTokenDelegate([row]);
    const abort = new AbortController();
    const payload = "git-pack";
    const response = await web.fetch(new Request(`${env.PUBLIC_ORIGIN}/api/v3/git/${repoId}.git/git-receive-pack`, {
      method: "POST", headers: { authorization: basicCredential(token) },
      body: payload, signal: abort.signal,
    }), env, context());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(payload);
    expect(mocks.next).not.toHaveBeenCalled();
    const forwarded = gitFetch.mock.calls[0][0];
    expect(forwarded.headers.get("x-beutl-repo-id")).toBe(repoId);
    abort.abort();
    expect(forwarded.signal.aborted).toBe(true);
  });

  it.each(["/api/v1/account/refresh", "/api/v2/identity/signInWith", "/api/v3/repos"])(
    "rejects oversized requests before Next buffers them: %s", async (path) => {
      const response = await web.fetch(new Request(`${env.PUBLIC_ORIGIN}${path}`, {
        method: "POST", headers: { "content-length": String(MAX_API_JSON_REQUEST_BYTES + 1) }, body: "x",
      }), env, context());
      expect(response.status).toBe(413);
      expect(mocks.next).not.toHaveBeenCalled();
    },
  );

  it("keeps Web pages and Web auth on OpenNext", async () => {
    for (const path of ["/ja", "/api/auth/session", "/api/v30/unknown"]) {
      expect((await web.fetch(new Request(`${env.PUBLIC_ORIGIN}${path}`), env, context())).status).toBe(200);
    }
    expect(mocks.next).toHaveBeenCalledTimes(3);
  });

  it.each(["/api/contents/file-1?image=preview-1024", "/_next/image?url=/img/test.png&w=64&q=75"])(
    "keeps the Images binding disabled by default for %s", async (path) => {
      const images = { input: vi.fn() };
      const bindings = { ...env, IMAGES: images };
      await web.fetch(new Request(`${env.PUBLIC_ORIGIN}${path}`), bindings, context());
      expect(mocks.next.mock.calls[0][1].IMAGES).toBeUndefined();
      expect(bindings.IMAGES).toBe(images);
    },
  );

  it.each(["/api/contents/file-1?image=preview-1024", "/api/contents/file-1/?image=thumbnail-320"])("passes the Images binding to the activated content route: %s", async (path) => {
    const images = { input: vi.fn() };
    const bindings = { ...env, IMAGES: images, BEUTL_IMAGE_FREE_TRANSFORMS_ENABLED: "true" };
    await web.fetch(new Request(`${env.PUBLIC_ORIGIN}${path}`), bindings, context());
    expect(mocks.next.mock.calls[0][1].IMAGES).toBe(images);
  });

  it.each([
    "/_next/image?url=https://beutl.beditor.net/api/contents/public-file&w=3840&q=75",
    "/_next/image/?url=/img/test.png&w=64&q=75",
    "/ja/dashboard/storage",
    "/api/contents/file-1/extra?image=preview-1024",
    "/api/contents/%2F..%2F..%2F_next%2Fimage?url=/img/test.png&w=3840&q=75",
  ])("withholds the binding outside the bounded content route even when activated: %s", async (path) => {
    const images = { input: vi.fn() };
    const bindings = { ...env, IMAGES: images, BEUTL_IMAGE_FREE_TRANSFORMS_ENABLED: "true" };
    await web.fetch(new Request(`${env.PUBLIC_ORIGIN}${path}`), bindings, context());
    expect(mocks.next.mock.calls[0][1].IMAGES).toBeUndefined();
    expect(bindings.IMAGES).toBe(images);
  });

  it("does not expose the binding to Server Actions posted to the content path", async () => {
    const images = { input: vi.fn() };
    const bindings = { ...env, IMAGES: images, BEUTL_IMAGE_FREE_TRANSFORMS_ENABLED: "true" };
    await web.fetch(new Request(`${env.PUBLIC_ORIGIN}/api/contents/file-1`, {
      method: "POST", headers: { "next-action": "40".padEnd(42, "0") }, body: "[]",
    }), bindings, context());
    expect(mocks.next.mock.calls[0][1].IMAGES).toBeUndefined();
  });

  it("hides a visitor's disconnect from page renders but not from Server Actions", async () => {
    const seen: Request[] = [];
    mocks.next.mockImplementation(async (request: Request) => {
      seen.push(request);
      return new Response("<html>", { headers: { "content-type": "text/html; charset=utf-8" } });
    });
    const page = new AbortController();
    const action = new AbortController();
    await web.fetch(new Request(`${env.PUBLIC_ORIGIN}/ja/store/demo`, { signal: page.signal }), env, context());
    await web.fetch(new Request(`${env.PUBLIC_ORIGIN}/ja/dashboard/ai`, {
      method: "POST", headers: { "next-action": "40".padEnd(42, "0") }, body: "[]", signal: action.signal,
    }), env, context());
    page.abort();
    action.abort();
    expect(seen.map((request) => request.signal.aborted)).toEqual([false, true]);
  });

  it("runs the complete shared scheduler from the Web cron", async () => {
    const scheduled = vi.spyOn(apiRuntime, "scheduled").mockResolvedValue();
    const controller = { scheduledTime: Date.now() }, ctx = context();
    await web.scheduled(controller, env, ctx);
    expect(scheduled).toHaveBeenCalledWith(controller, env, ctx);
  });

  it("deploys public APIs and Git Durable Objects only with Web", () => {
    const config = readFileSync(new URL("../../apps/web/wrangler.jsonc", import.meta.url), "utf8");
    const root = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    const api = JSON.parse(readFileSync(new URL("../../packages/api/package.json", import.meta.url), "utf8"));
    expect(config).toContain('"main": "worker.js"');
    const vars = config.slice(config.indexOf('"vars":'));
    expect(vars).not.toContain('"JWT_EXPIRATION_MINUTES"');
    expect(vars).not.toContain('"JWT_REFRESH_TOKEN_EXPIRATION_DAYS"');
    expect(vars).not.toContain('"BEUTL_GIT_ENABLED"');
    expect(config).toContain('"class_name": "GitRepositoryDurableObject"');
    expect(config).toContain('"new_sqlite_classes": ["GitRepositoryDurableObject"]');
    expect(GitRepositoryDurableObject).toBeTypeOf("function");
    expect(root.scripts["deploy:api"]).toBeUndefined();
    expect(root.scripts["upload:api"]).toBeUndefined();
    expect(api.scripts.deploy).toBeUndefined();
    expect(existsSync(new URL("../../packages/api/wrangler.jsonc", import.meta.url))).toBe(false);
  });
});
