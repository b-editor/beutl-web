import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { sign } from "hono/jwt";
import { setDbProvider } from "@beutl/db";

// Hosted Git is registered in the shared Hono v3 app. The deployed Worker entry
// and the Next.js /api/v3 route must therefore expose the same routes and
// responses, with the same bindings.

const mocks = vi.hoisted(() => ({ next: vi.fn(async () => new Response("Next page")), db: {} as any, context: vi.fn() }));
vi.mock("../../apps/web/.open-next/worker.js", () => ({
  default: { fetch: mocks.next },
  DOQueueHandler: class {}, DOShardedTagCache: class {}, BucketCachePurge: class {},
}));
vi.mock("@prisma/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@prisma/client")>(),
  PrismaClient: class { constructor() { return mocks.db; } },
}));
import web from "../../apps/web/worker.js";
import { basicCredential, gitAccessTokenDelegate, gitAccessTokenFixture, type GitAccessTokenRow } from "../stubs/git-access-tokens";

type Handler = (request: Request) => Response | Promise<Response>;
let next: Record<string, Handler>;
const origin = "https://beutl.beditor.net";
const repoId = "11111111-1111-4111-8111-111111111111";
const oid = "a".repeat(64);
const createdAt = new Date("2026-10-04T00:00:00Z");
const row = { id: repoId, ownerId: "owner", name: "demo", deletedAt: null, createdAt, updatedAt: createdAt };
const objectFetch = vi.fn(async (request: Request) => Response.json({ path: new URL(request.url).pathname,
  scope: request.headers.get("x-beutl-git-scope"), owner: request.headers.get("x-beutl-git-owner-id") }));
const env = {
  BEUTL_DATABASE_HYPERDRIVE: { connectionString: "postgres://routes-test" },
  JWT_SECRET: "hosted-git-routes-test-secret", JWT_ISSUER: "", JWT_AUDIENCE: "",
  PUBLIC_ORIGIN: origin, BEUTL_GIT_ENABLED: "true",
  BEUTL_S3_ENDPOINT: "https://s3.example.test", BEUTL_S3_REGION: "test",
  BEUTL_S3_BUCKET: "git", BEUTL_S3_ACCESS_KEY_ID: "test", BEUTL_S3_SECRET_ACCESS_KEY: "test",
  BEUTL_GIT_REPOSITORIES: { idFromName: (name: string) => name, get: () => ({ fetch: objectFetch }) },
};
const context = () => ({ waitUntil: (_promise: Promise<unknown>) => undefined, passThroughOnException() {}, props: {} });
const readTokenId = "44444444-4444-4444-8444-444444444444";
const secrets = { read: "", write: "" };
let tokenRows: GitAccessTokenRow[] = [];

beforeAll(async () => {
  const fromWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));
  vi.doMock(fromWeb.resolve("@opennextjs/cloudflare"), () => ({ getCloudflareContext: mocks.context }));
  next = await import("../../apps/web/src/app/api/v3/[[...route]]/route") as unknown as Record<string, Handler>;
  const read = await gitAccessTokenFixture({ repoId, scope: "read" });
  const write = await gitAccessTokenFixture({ repoId, scope: "write" });
  read.row.id = readTokenId;
  secrets.read = read.token; secrets.write = write.token;
  tokenRows = [read.row, write.row];
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.mockImplementation(() => ({ env, ctx: context() }));
  mocks.db = {
    $disconnect: vi.fn(async () => undefined),
    $transaction: async (work: (db: unknown) => unknown) => work(mocks.db),
    user: { update: vi.fn(async () => ({ id: "owner" })) },
    gitRepository: {
      findMany: vi.fn(async () => [row]), findUnique: vi.fn(async () => null), count: vi.fn(async () => 0),
      findFirst: vi.fn(async ({ where }) => where.id === repoId && where.ownerId === "owner" ? row : null),
      create: vi.fn(async () => row),
      update: vi.fn(async ({ data }) => ({ ...row, ...data })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    gitAccessToken: {
      ...gitAccessTokenDelegate(tokenRows),
      findMany: vi.fn(async () => tokenRows), count: vi.fn(async () => tokenRows.length),
      create: vi.fn(async ({ data }) => ({ ...data, id: "55555555-5555-4555-8555-555555555555",
        createdAt: createdAt, lastUsedAt: null, revokedAt: null })),
    },
  };
  // The Worker binds its own client per invocation; Next uses the global provider.
  setDbProvider(async () => mocks.db);
  for (const [key, value] of Object.entries(env)) if (typeof value === "string") vi.stubEnv(key, value);
});
afterEach(() => { vi.unstubAllEnvs(); });

async function apiToken() {
  return `Bearer ${await sign({ "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier": "owner",
    exp: Math.floor(Date.now() / 1000) + 300 }, env.JWT_SECRET, "HS256")}`;
}
// Git sends the token embedded in `https://USER:TOKEN@host/...` as Basic credentials.
async function gitToken(scope: "read" | "write") {
  return basicCredential(secrets[scope]);
}
async function both(method: string, path: string, init: { authorization?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const request = () => new Request(`${origin}${path}`, {
    method, headers: { ...(init.authorization ? { authorization: init.authorization } : {}),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const worker = await web.fetch(request(), env, context());
  const route = await next[method](request());
  return { worker, route };
}
async function snapshot(response: Response) {
  const text = await response.text();
  return { status: response.status, body: text, tus: response.headers.get("tus-resumable"),
    cache: response.headers.get("cache-control"), auth: response.headers.get("www-authenticate") };
}

describe("Hosted Git routes in the Worker and the Next.js v3 route", () => {
  it("exports every method Git, LFS and tus use, so Next never answers them itself", () => {
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) expect(next[method]).toBeTypeOf("function");
  });

  it.each([
    ["GET", "/api/v3/repos", undefined],
    ["POST", "/api/v3/repos", { name: "demo", creationId: repoId, ownerId: "owner" }],
    ["GET", `/api/v3/repos/${repoId}`, undefined],
    ["PATCH", `/api/v3/repos/${repoId}`, { name: "renamed" }],
    ["DELETE", `/api/v3/repos/${repoId}`, undefined],
    ["GET", "/api/v3/repos/22222222-2222-4222-8222-222222222222", undefined],
    ["GET", `/api/v3/repos/${repoId}/tokens`, undefined],
    ["POST", `/api/v3/repos/${repoId}/tokens`, { name: " ", scope: "write" }],
    ["POST", `/api/v3/repos/${repoId}/tokens`, { name: "laptop", scope: "admin" }],
    ["DELETE", `/api/v3/repos/${repoId}/tokens/${readTokenId}`, undefined],
    ["DELETE", `/api/v3/repos/${repoId}/tokens/not-a-token`, undefined],
  ])("serves %s %s identically", async (method, path, body) => {
    const authorization = await apiToken();
    const { worker, route } = await both(method, path, { authorization, body });
    expect(await snapshot(worker)).toEqual(await snapshot(route));
    expect(worker.status).toBeLessThan(500);
    expect(mocks.next).not.toHaveBeenCalled();
  });

  it("creates equivalent access tokens through both paths and shows the secret once", async () => {
    const { worker, route } = await both("POST", `/api/v3/repos/${repoId}/tokens`, { authorization: await apiToken(), body: { name: " laptop ", scope: "write" } });
    expect(worker.status).toBe(201); expect(route.status).toBe(201);
    const [fromWorker, fromRoute] = [await worker.json(), await route.json()];
    expect(Object.keys(fromWorker).sort()).toEqual(Object.keys(fromRoute).sort());
    expect(fromWorker).toMatchObject({ name: "laptop", scope: "write", lastUsedAt: null });
    expect(fromWorker.token).toMatch(/^bgt_[A-Za-z0-9_-]{43}$/u);
    expect(fromWorker.token).not.toBe(fromRoute.token);
    // Only the hash is stored.
    const stored = mocks.db.gitAccessToken.create.mock.calls[0][0].data;
    expect(stored).not.toHaveProperty("token");
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(stored.hint).toBe(fromWorker.token.slice(-4));
  });

  it.each([
    ["the password of USER:TOKEN", (token: string) => basicCredential(token, "anyone")],
    ["the user name with no password", (token: string) => `Basic ${btoa(token)}`],
    ["a Bearer credential", (token: string) => `Bearer ${token}`],
  ])("accepts an access token as %s", async (_form, credential) => {
    const { worker, route } = await both("GET", `/api/v3/git/${repoId}.git/info/refs?service=git-upload-pack`, { authorization: credential(secrets.read) });
    expect([worker.status, route.status]).toEqual([200, 200]);
  });

  it("refuses revoked tokens and tokens whose repository was deleted or changed owner", async () => {
    for (const variant of [{ revokedAt: new Date() }, { repository: { ownerId: "owner", deletedAt: new Date() } },
      { repository: { ownerId: "someone-else", deletedAt: null } }]) {
      const fixture = await gitAccessTokenFixture({ repoId, ...variant });
      mocks.db.gitAccessToken.findUnique.mockResolvedValueOnce(fixture.row).mockResolvedValueOnce(fixture.row);
      const { worker, route } = await both("GET", `/api/v3/git/${repoId}.git/info/refs?service=git-upload-pack`, { authorization: basicCredential(fixture.token) });
      expect([worker.status, route.status]).toEqual(variant.revokedAt ? [401, 401] : [404, 404]);
    }
    expect(objectFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", `/api/v3/git/${repoId}.git/info/refs?service=git-upload-pack`, "read"],
    ["GET", `/api/v3/git/${repoId}.git/info/refs?service=git-receive-pack`, "write"],
    ["POST", `/api/v3/git/${repoId}.git/git-upload-pack`, "read"],
    ["POST", `/api/v3/git/${repoId}.git/git-receive-pack`, "write"],
    ["POST", `/api/v3/git/${repoId}.git/info/lfs/objects/batch`, "read"],
  ] as const)("forwards %s %s to the repository object with the verified %s scope", async (method, path, scope) => {
    const { worker, route } = await both(method, path, { authorization: await gitToken(scope), body: method === "POST" ? {} : undefined });
    const result = await snapshot(worker);
    expect(result).toEqual(await snapshot(route));
    expect(JSON.parse(result.body)).toEqual({ path: new URL(`${origin}${path}`).pathname, scope, owner: "owner" });
  });

  it.each([
    ["GET", `/api/v3/git/${repoId}.git/info/refs?service=git-receive-pack`, "read", 403],
    ["POST", `/api/v3/git/${repoId}.git/git-receive-pack`, "read", 403],
    ["POST", `/api/v3/git/${repoId}.git/info/lfs/objects/${oid}/tus`, "read", 403],
    ["GET", `/api/v3/git/${repoId}.git/info/refs?service=git-upload-pack`, undefined, 401],
    ["GET", `/api/v3/git/22222222-2222-4222-8222-222222222222.git/info/refs?service=git-upload-pack`, "read", 401],
    ["GET", `/api/v3/git/${repoId}.git/config`, "read", 404],
    ["OPTIONS", `/api/v3/git/${repoId}.git/info/lfs/objects/${oid}/tus`, undefined, 401],
    ["OPTIONS", `/api/v3/git/${repoId}.git/info/lfs/objects/${oid}/tus`, "write", 204],
    ["POST", `/api/v3/git/${repoId}.git/info/lfs/objects/${oid}/tus`, "write", 412],
    ["GET", `/api/v3/git/${repoId}.git/info/lfs/objects/${oid}/tus/${repoId}`, "write", 412],
    ["POST", `/api/v3/git/${repoId}.git/info/lfs/objects/${oid}/verify`, undefined, 401],
    ["POST", `/api/v3/git/${repoId}.git/info/lfs/objects/${oid}/verify`, "read", 403],
    ["POST", `/api/v3/git/${repoId}.git/info/lfs/locks/verify`, undefined, 401],
    ["POST", `/api/v3/git/${repoId}.git/info/lfs/locks/verify`, "read", 501],
  ] as const)("enforces %s %s with %s identically (%i)", async (method, path, scope, status) => {
    const authorization = scope ? await gitToken(scope) : undefined;
    const { worker, route } = await both(method, path, { authorization });
    const result = await snapshot(worker);
    expect(result).toEqual(await snapshot(route));
    expect(result.status).toBe(status);
    if (path.includes("/tus")) expect(result.tus).toBe("1.0.0");
    if (status === 401) expect(result.auth).toBe("Basic realm=\"Beutl Git\", charset=\"UTF-8\"");
  });

  it("forwards a basic-transfer LFS verify with write scope identically", async () => {
    objectFetch.mockClear();
    const path = `/api/v3/git/${repoId}.git/info/lfs/objects/${oid}/verify`;
    const { worker, route } = await both("POST", path, { authorization: await gitToken("write"), body: { oid, size: 3 } });
    expect(await snapshot(worker)).toEqual(await snapshot(route));
    expect(worker.status).toBe(200);
    const forwarded = objectFetch.mock.calls.map(([request]) => request);
    expect(forwarded.map((request) => new URL(request.url).pathname)).toEqual(Array(2).fill(`/internal/git/media/${oid}/verify`));
    expect(forwarded.map((request) => request.headers.get("x-beutl-git-scope"))).toEqual(["write", "write"]);
    expect(await forwarded[0].json()).toEqual({ size: 3 });
  });

  it("keeps Hosted Git hidden on both paths when the environment disables it", async () => {
    const disabled = { ...env, BEUTL_GIT_ENABLED: "false" };
    mocks.context.mockImplementation(() => ({ env: disabled, ctx: context() }));
    for (const path of ["/api/v3/repos", `/api/v3/git/${repoId}.git/info/refs?service=git-upload-pack`]) {
      const worker = await web.fetch(new Request(`${origin}${path}`, { headers: { authorization: await apiToken() } }), disabled, context());
      const route = await next.GET(new Request(`${origin}${path}`, { headers: { authorization: await apiToken() } }));
      expect([worker.status, route.status]).toEqual([404, 404]);
    }
    expect(objectFetch).not.toHaveBeenCalled();
  });
});
