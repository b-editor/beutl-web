import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { runWithDbProvider } from "@beutl/db";

const mocks = vi.hoisted(() => ({ context: vi.fn(), revalidate: vi.fn(), authenticated: vi.fn(), signedIn: true }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@beutl/next/language", () => ({ getLanguage: async () => "ja" }));
vi.mock("@beutl/i18n", () => ({ getTranslation: async () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/auth-guard", () => ({ authenticated: mocks.authenticated }));

let actions: typeof import("../../apps/web/src/app/[lang]/(dashboard)/dashboard/account/security/api-key-actions");
const repositoryId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const otherId = "99999999-9999-4999-8999-999999999999";
const tokenId = "66666666-6666-4666-8666-666666666666";
const nugetId = "77777777-7777-4777-8777-777777777777";
const createdAt = new Date("2026-10-04T00:00:00Z");
const expiresAt = new Date("2026-11-04T00:00:00Z");
const gitRow = { id: tokenId, name: "Laptop", scope: "write", hint: "abcd", createdAt, lastUsedAt: createdAt,
  ownerId: "owner", repoId: repositoryId, tokenHash: "private-git-hash", revokedAt: null };
const repository = { id: repositoryId, ownerId: "owner", name: "Project", deletedAt: null, createdAt, updatedAt: createdAt, accessTokens: [gitRow] };
const nugetRow = { id: nugetId, name: "NuGet CI", hint: "abcdef", canPush: true, createdAt, expiresAt,
  userId: "owner", tokenHash: "private-nuget-hash", revokedAt: null };
const gitEnv = {
  BEUTL_GIT_ENABLED: "true", BEUTL_GIT_REPOSITORIES: { idFromName: vi.fn(), get: vi.fn() },
  BEUTL_S3_ENDPOINT: "https://s3.example", BEUTL_S3_REGION: "test-region", BEUTL_S3_BUCKET: "git",
  BEUTL_S3_ACCESS_KEY_ID: "test-key", BEUTL_S3_SECRET_ACCESS_KEY: "test-secret", PUBLIC_ORIGIN: "https://git.example",
};
let db: any;
const withDb = <T>(run: () => Promise<T>) => runWithDbProvider(async () => db, run);
const nugetInput = { kind: "nuget", name: " Build ", scope: "push", days: 30 } as const;
const gitInput = { kind: "repository", name: " Laptop ", scope: "write", repositoryId } as const;
const failure = (code: string) => ({ success: false, message: `account:apiKeys.errors.${code}` });

beforeAll(async () => {
  const fromWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));
  vi.doMock(fromWeb.resolve("@opennextjs/cloudflare"), () => ({ getCloudflareContext: mocks.context }));
  actions = await import("../../apps/web/src/app/[lang]/(dashboard)/dashboard/account/security/api-key-actions");
});
beforeEach(() => {
  vi.clearAllMocks(); mocks.signedIn = true;
  mocks.context.mockResolvedValue({ env: gitEnv });
  mocks.authenticated.mockImplementation(async (run) => mocks.signedIn ? run({ user: { id: "owner" } }) : { success: false, message: "Unauthenticated" });
  db = {
    $transaction: async (work: (tx: unknown) => unknown) => work(db),
    gitRepository: {
      findMany: vi.fn(async () => [repository]),
      findFirst: vi.fn(async ({ where }) => where.id === repositoryId && where.ownerId === "owner" ? repository : null),
    },
    gitAccessToken: {
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }) => ({ ...gitRow, ...data, lastUsedAt: null })),
      updateMany: vi.fn(async ({ where }) => ({ count: where.id === tokenId && where.repoId === repositoryId && where.ownerId === "owner" ? 1 : 0 })),
    },
    nugetToken: {
      findMany: vi.fn(async () => [nugetRow]),
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }) => ({ ...nugetRow, ...data })),
      updateMany: vi.fn(async ({ where }) => ({ count: where.id === nugetId && where.userId === "owner" ? 1 : 0 })),
    },
  };
});

describe("Account security API keys", () => {
  it("requires an authoritative session for listing, issuance and revocation", async () => {
    mocks.signedIn = false;
    for (const run of [actions.retrieveApiKeys, () => actions.createApiKey(nugetInput), () => actions.createApiKey(gitInput),
      () => actions.revokeApiKey({ kind: "nuget", id: nugetId }), () => actions.revokeApiKey({ kind: "repository", id: tokenId, repositoryId })]) {
      expect(await withDb(run)).toEqual(failure("unauthorized"));
    }
    expect(mocks.authenticated.mock.calls.every((call) => call[1] === true)).toBe(true);
    expect(db.gitRepository.findMany).not.toHaveBeenCalled();
    expect(db.gitAccessToken.create).not.toHaveBeenCalled();
    expect(db.nugetToken.create).not.toHaveBeenCalled();
    expect(db.nugetToken.updateMany).not.toHaveBeenCalled();
    expect(db.gitAccessToken.updateMany).not.toHaveBeenCalled();
  });
  it("lists both services with owner-scoped queries and excludes all credential hashes", async () => {
    const result = await withDb(actions.retrieveApiKeys);
    expect(result).toEqual({ success: true, data: {
      gitAvailable: true, repositories: [{ id: repositoryId, name: "Project" }], keys: [
        { kind: "nuget", id: nugetId, name: "NuGet CI", hint: "abcdef", scope: "push", createdAt: createdAt.toISOString(), expiresAt: expiresAt.toISOString() },
        { kind: "repository", id: tokenId, name: "Laptop", scope: "write", hint: "abcd", createdAt: createdAt.toISOString(), lastUsedAt: createdAt.toISOString(), repositoryId, repositoryName: "Project" },
      ],
    } });
    expect(db.nugetToken.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: "owner", revokedAt: null, expiresAt: { gt: expect.any(Date) } },
    }));
    expect(db.gitRepository.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { ownerId: "owner", deletedAt: null },
      select: expect.objectContaining({ accessTokens: expect.objectContaining({ where: { ownerId: "owner", revokedAt: null } }) }),
    }));
    expect(JSON.stringify(result)).not.toContain("private-");
  });
  it("keeps existing keys visible and revocable and NuGet issuance available when Git is disabled", async () => {
    mocks.context.mockResolvedValue({ env: { ...gitEnv, BEUTL_GIT_ENABLED: "false" } });
    expect(await withDb(actions.retrieveApiKeys)).toMatchObject({ success: true, data: { gitAvailable: false, keys: [expect.anything(), expect.anything()] } });
    expect((await withDb(() => actions.revokeApiKey({ kind: "repository", id: tokenId, repositoryId }))).success).toBe(true);
    expect((await withDb(() => actions.createApiKey(nugetInput))).success).toBe(true);
    expect(await withDb(() => actions.createApiKey(gitInput))).toEqual(failure("gitUnavailable"));
    expect(db.gitAccessToken.create).not.toHaveBeenCalled();
  });
  it.each([
    { ...nugetInput, kind: "admin" }, { ...nugetInput, scope: "write" }, { ...gitInput, scope: "push" },
    { ...nugetInput, name: " " }, { ...gitInput, name: "bad\nname" },
    { ...nugetInput, name: "x".repeat(101) }, { ...gitInput, name: "x".repeat(81) },
    { ...nugetInput, days: 0 }, { ...nugetInput, days: 366 }, { ...nugetInput, days: 1.5 },
    { ...gitInput, repositoryId: "../repos" },
  ])("rejects invalid issuance settings without generating a key: %j", async (input) => {
    expect(await withDb(() => actions.createApiKey(input as any))).toEqual(failure("invalidSettings"));
    expect(db.nugetToken.create).not.toHaveBeenCalled();
    expect(db.gitAccessToken.create).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it("does not issue repository keys for another owner or a deleted repository", async () => {
    expect(await withDb(() => actions.createApiKey({ ...gitInput, repositoryId: otherId }))).toEqual(failure("notFound"));
    expect(db.gitRepository.findFirst).toHaveBeenCalledWith({ where: { id: otherId, ownerId: "owner", deletedAt: null } });
    db.gitRepository.findFirst.mockResolvedValueOnce(repository).mockResolvedValueOnce(null);
    expect(await withDb(() => actions.createApiKey(gitInput))).toEqual(failure("notFound"));
    expect(db.gitAccessToken.create).not.toHaveBeenCalled();
  });
  it("issues an expiring NuGet key, stores only its hash and refreshes security", async () => {
    const result = await withDb(() => actions.createApiKey(nugetInput));
    if (!result.success || !result.data) throw new Error("missing key");
    const { secret, key } = result.data;
    expect(secret).toMatch(/^bn_[a-f0-9]{64}$/u);
    expect(key).toMatchObject({ kind: "nuget", name: "Build", scope: "push" });
    expect(key).not.toHaveProperty("secret");
    expect(key).not.toHaveProperty("tokenHash");
    const stored = db.nugetToken.create.mock.calls[0][0].data;
    expect(stored).toEqual({ userId: "owner", name: "Build", canPush: true, tokenHash: createHash("sha256").update(secret).digest("hex"), hint: secret.slice(-6), expiresAt: expect.any(Date) });
    expect(Math.abs(stored.expiresAt.getTime() - Date.now() - 30 * 86400000)).toBeLessThan(5000);
    expect(mocks.revalidate).toHaveBeenCalledWith("/ja/dashboard/account/security");
  });
  it("issues a non-expiring Git key for one repository and preserves the clone URL", async () => {
    const result = await withDb(() => actions.createApiKey(gitInput));
    if (!result.success || !result.data) throw new Error("missing key");
    const { secret, key, cloneUrl } = result.data;
    expect(secret).toMatch(/^bgt_[A-Za-z0-9_-]{43}$/u);
    expect(key).toMatchObject({ kind: "repository", name: "Laptop", repositoryId, scope: "write", lastUsedAt: null });
    expect(key).not.toHaveProperty("token");
    expect(key).not.toHaveProperty("tokenHash");
    expect(key).not.toHaveProperty("expiresAt");
    expect(cloneUrl).toBe(`https://git.example/api/v3/git/${repositoryId}.git`);
    expect(db.gitAccessToken.create.mock.calls[0][0].data).toEqual({ repoId: repositoryId, ownerId: "owner", name: "Laptop", scope: "write", tokenHash: createHash("sha256").update(secret).digest("hex"), hint: secret.slice(-4) });
    expect(mocks.revalidate).toHaveBeenCalledWith("/ja/dashboard/account/security");
  });
  it("preserves read-only scope for both key types", async () => {
    await withDb(() => actions.createApiKey({ ...nugetInput, scope: "read" }));
    await withDb(() => actions.createApiKey({ ...gitInput, scope: "read" }));
    expect(db.nugetToken.create.mock.calls[0][0].data.canPush).toBe(false);
    expect(db.gitAccessToken.create.mock.calls[0][0].data.scope).toBe("read");
  });
  it("enforces the existing active-key caps for both services", async () => {
    db.nugetToken.count.mockResolvedValue(20);
    db.gitAccessToken.count.mockResolvedValue(50);
    expect(await withDb(() => actions.createApiKey(nugetInput))).toEqual(failure("nugetLimitReached"));
    expect(await withDb(() => actions.createApiKey(gitInput))).toEqual(failure("repositoryLimitReached"));
    expect(db.nugetToken.count).toHaveBeenCalledWith({ where: { userId: "owner", revokedAt: null, expiresAt: { gt: expect.any(Date) } } });
    expect(db.gitAccessToken.count).toHaveBeenCalledWith({ where: { repoId: repositoryId, ownerId: "owner", revokedAt: null } });
    expect(db.nugetToken.create).not.toHaveBeenCalled();
    expect(db.gitAccessToken.create).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it("revokes each kind with owner/resource filters and rejects missing or foreign keys", async () => {
    expect((await withDb(() => actions.revokeApiKey({ kind: "nuget", id: nugetId }))).success).toBe(true);
    expect((await withDb(() => actions.revokeApiKey({ kind: "repository", id: tokenId, repositoryId }))).success).toBe(true);
    expect(db.nugetToken.updateMany).toHaveBeenCalledWith({ where: { id: nugetId, userId: "owner", revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    expect(db.gitAccessToken.updateMany).toHaveBeenCalledWith({ where: { id: tokenId, ownerId: "owner", repoId: repositoryId, revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    expect(await withDb(() => actions.revokeApiKey({ kind: "nuget", id: otherId }))).toEqual(failure("notFound"));
    expect(await withDb(() => actions.revokeApiKey({ kind: "repository", id: tokenId, repositoryId: otherId }))).toEqual(failure("notFound"));
  });
  it("rejects invalid revocation targets before mutation", async () => {
    for (const input of [{ kind: "admin", id: tokenId }, { kind: "nuget", id: "../keys" }, { kind: "repository", id: tokenId, repositoryId: "invalid" }]) {
      expect(await withDb(() => actions.revokeApiKey(input as any))).toEqual(failure("invalidSettings"));
    }
    expect(db.nugetToken.updateMany).not.toHaveBeenCalled();
    expect(db.gitAccessToken.updateMany).not.toHaveBeenCalled();
  });
  it("does not expose database failures or secrets in error messages", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      db.nugetToken.findMany.mockRejectedValue(new Error("connection URL and credentials"));
      expect(await withDb(actions.retrieveApiKeys)).toEqual(failure("requestFailed"));
      expect(log).toHaveBeenCalledWith("API key action failed", { type: "Error" });
    } finally { log.mockRestore(); }
  });
});
