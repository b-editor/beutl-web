import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { isValidGitRepositoryName } from "@beutl/core";
import { runWithDbProvider } from "@beutl/db";
import { authenticatedCloneUrl, repositoryCloneCommand } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/repositories/connection";

const mocks = vi.hoisted(() => ({ context: vi.fn(), revalidate: vi.fn(), signedIn: true }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@beutl/next/language", () => ({ getLanguage: async () => "ja" }));
vi.mock("@beutl/i18n", () => ({ getTranslation: async () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/auth-guard", () => ({
  authenticated: async (run: (session: unknown) => unknown) => mocks.signedIn
    ? run({ user: { id: "owner" } }) : { success: false, message: "Unauthenticated" },
}));

let actions: typeof import("../../apps/web/src/app/[lang]/(dashboard)/dashboard/repositories/actions");
const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const tokenId = "66666666-6666-4666-8666-666666666666";
const createdAt = new Date("2026-10-04T00:00:00Z");
const row = { id, ownerId: "owner", name: "Project", deletedAt: null, createdAt, updatedAt: createdAt };
const repository = { id, name: "Project", url: `https://git.example/api/v3/git/${id}.git`,
  createdAt: createdAt.toISOString(), updatedAt: createdAt.toISOString() };
const cleanup = vi.fn(async (_request: Request) => new Response(null, { status: 204 }));
const namespace = { idFromName: vi.fn((name: string) => name), get: vi.fn(() => ({ fetch: cleanup })) };
const gitEnv = {
  BEUTL_GIT_ENABLED: "true", BEUTL_GIT_REPOSITORIES: namespace,
  BEUTL_S3_ENDPOINT: "https://s3.example", BEUTL_S3_REGION: "test-region", BEUTL_S3_BUCKET: "git",
  BEUTL_S3_ACCESS_KEY_ID: "test-key", BEUTL_S3_SECRET_ACCESS_KEY: "test-secret",
  PUBLIC_ORIGIN: "https://git.example",
};
let db: any;
const repositoryOperations = [
  { name: "rename", run: () => actions.renameRepository(id, "New name") },
  { name: "delete", run: () => actions.deleteRepository(id) },
  { name: "token creation", run: () => actions.createRepositoryToken(id, "Laptop", "read") },
  { name: "token listing", run: () => actions.listRepositoryTokens(id) },
];
const withDb = <T>(run: () => Promise<T>) => runWithDbProvider(async () => db, run);

beforeAll(async () => {
  const fromWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));
  vi.doMock(fromWeb.resolve("@opennextjs/cloudflare"), () => ({ getCloudflareContext: mocks.context }));
  actions = await import("../../apps/web/src/app/[lang]/(dashboard)/dashboard/repositories/actions");
});
beforeEach(() => {
  vi.clearAllMocks(); mocks.signedIn = true;
  mocks.context.mockResolvedValue({ env: gitEnv });
  db = {
    $transaction: async (work: (tx: unknown) => unknown) => work(db),
    user: { update: vi.fn(async () => ({ id: "owner" })) },
    gitRepository: {
      findMany: vi.fn(async () => [row]),
      findFirst: vi.fn(async ({ where }) => where.id === id && where.ownerId === "owner" ? row : null),
      findUnique: vi.fn(async () => null),
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }) => ({ ...row, ...data })),
      update: vi.fn(async ({ where, data }) => {
        if (where.id !== id || where.ownerId !== "owner") throw { code: "P2025" };
        return { ...row, ...data };
      }),
      updateMany: vi.fn(async ({ where }) => ({ count: where.id === id && where.ownerId === "owner" ? 1 : 0 })),
    },
    gitAccessToken: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }) => ({ ...data, id: tokenId, createdAt, lastUsedAt: null, revokedAt: null })),
      updateMany: vi.fn(async ({ where }) => ({ count: where.id === tokenId && where.repoId === id && where.ownerId === "owner" ? 1 : 0 })),
    },
  };
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("Web repository management", () => {
  it("lists the session owner's repositories in process without API credentials or network", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(await withDb(actions.retrieveRepositories)).toEqual({ success: true, data: [repository] });
    expect(db.gitRepository.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { ownerId: "owner", deletedAt: null } }));
    expect(mocks.context).toHaveBeenCalledWith({ async: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it("does not touch repositories for an anonymous session or a changed account", async () => {
    mocks.signedIn = false;
    expect(await withDb(actions.retrieveRepositories)).toEqual({ success: false, message: "dashboard:repositories.errors.unauthorized" });
    mocks.signedIn = true;
    expect(await withDb(() => actions.createRepository("Project", id, "someone-else"))).toMatchObject({ success: false, message: "dashboard:repositories.errors.accountChanged" });
    expect(db.gitRepository.findMany).not.toHaveBeenCalled();
    expect(db.gitRepository.create).not.toHaveBeenCalled();
  });
  it("keeps the creation identifier and returns the same repository on retry", async () => {
    db.gitRepository.create.mockRejectedValueOnce(new Error("connection lost"));
    expect((await withDb(() => actions.createRepository(" Project ", id, "owner"))).success).toBe(false);
    expect(await withDb(() => actions.createRepository(" Project ", id, "owner"))).toEqual({ success: true, data: repository });
    db.gitRepository.findUnique.mockResolvedValueOnce(row);
    expect(await withDb(() => actions.createRepository(" Project ", id, "owner"))).toEqual({ success: true, data: repository });
    for (const [input] of db.gitRepository.create.mock.calls) {
      expect(input).toEqual({ data: { id, ownerId: "owner", name: "Project" } });
    }
    expect(db.gitRepository.create).toHaveBeenCalledTimes(2);
    expect(mocks.revalidate.mock.calls).toEqual([
      ["/ja/dashboard/repositories"], ["/ja/dashboard/storage"],
      ["/ja/dashboard/repositories"], ["/ja/dashboard/storage"],
    ]);
  });
  it("reports a creation identifier reused for another repository as a conflict", async () => {
    db.gitRepository.findUnique.mockResolvedValueOnce({ ...row, name: "Other" });
    expect(await withDb(() => actions.createRepository("Project", id, "owner"))).toMatchObject({ success: false, message: "dashboard:repositories.errors.conflict" });
    expect(db.gitRepository.create).not.toHaveBeenCalled();
  });
  it.each(["", "  ", "a/b", "a\\b", "a\u0000b", "\u0085", "a\u009fb", "x".repeat(81)])("rejects an invalid name before mutation: %j", async (name) => {
    expect(isValidGitRepositoryName(name)).toBe(false);
    expect((await withDb(() => actions.createRepository(name, id, "owner"))).success).toBe(false);
    expect((await withDb(() => actions.renameRepository(id, name))).success).toBe(false);
    expect(db.gitRepository.create).not.toHaveBeenCalled();
    expect(db.gitRepository.update).not.toHaveBeenCalled();
  });
  it("rejects path traversal, a nil creation ID, and unsupported token scopes", async () => {
    expect((await withDb(() => actions.deleteRepository("../repos"))).success).toBe(false);
    expect((await withDb(() => actions.createRepository("Project", "00000000-0000-0000-0000-000000000000", "owner"))).success).toBe(false);
    expect((await withDb(() => actions.createRepositoryToken(id, "Laptop", "admin" as "read"))).success).toBe(false);
    expect((await withDb(() => actions.createRepositoryToken(id, "bad\nname", "read"))).success).toBe(false);
    expect((await withDb(() => actions.revokeRepositoryToken(id, "../tokens"))).success).toBe(false);
    expect(db.gitAccessToken.create).not.toHaveBeenCalled();
    expect(db.gitAccessToken.updateMany).not.toHaveBeenCalled();
    expect(db.gitRepository.updateMany).not.toHaveBeenCalled();
    expect(db.gitRepository.create).not.toHaveBeenCalled();
    expect(db.gitRepository.findFirst).not.toHaveBeenCalled();
  });
  it.each([
    ["disabled", { ...gitEnv, BEUTL_GIT_ENABLED: "false" }],
    ["unconfigured", { ...gitEnv, BEUTL_S3_BUCKET: undefined }],
  ])("distinguishes a %s Git service from an empty list", async (_case, env) => {
    mocks.context.mockResolvedValue({ env });
    expect(await withDb(actions.retrieveRepositories)).toEqual({ success: false, message: "dashboard:repositories.errors.unavailable" });
    expect(db.gitRepository.findMany).not.toHaveBeenCalled();
    mocks.context.mockResolvedValue({ env: gitEnv });
    db.gitRepository.findMany.mockResolvedValue([]);
    expect(await withDb(actions.retrieveRepositories)).toEqual({ success: true, data: [] });
  });
  it("reports a database failure as a failed request", async () => {
    db.gitRepository.findMany.mockRejectedValue(new Error("database unavailable"));
    expect(await withDb(actions.retrieveRepositories)).toEqual({ success: false, message: "dashboard:repositories.errors.requestFailed" });
  });
  it.each(repositoryOperations)("reports a disabled Git service as unavailable during $name", async ({ run }) => {
    mocks.context.mockResolvedValue({ env: { ...gitEnv, BEUTL_GIT_ENABLED: "false" } });
    expect(await withDb(run)).toEqual({ success: false, message: "dashboard:repositories.errors.unavailable" });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it.each(repositoryOperations)("reports another account's or a missing repository as not found during $name", async ({ run }) => {
    db.gitRepository.findFirst.mockResolvedValue(null);
    db.gitRepository.update.mockRejectedValue({ code: "P2025" });
    db.gitRepository.updateMany.mockResolvedValue({ count: 0 });
    expect(await withDb(run)).toEqual({ success: false, message: "dashboard:repositories.errors.notFound" });
    expect(cleanup).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it("reports the repository cap without refreshing paths on failure", async () => {
    db.gitRepository.count.mockResolvedValue(20);
    expect(await withDb(() => actions.createRepository("Project", id, "owner"))).toMatchObject({ success: false, message: "dashboard:repositories.errors.limitReached" });
    expect(db.gitRepository.create).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it("renames and deletes owner-scoped rows, cleaning storage through the Web Durable Object binding", async () => {
    expect(await withDb(() => actions.renameRepository(id, " New name "))).toEqual({ success: true, data: { ...repository, name: "New name" } });
    expect(db.gitRepository.update).toHaveBeenCalledWith({ where: { id, ownerId: "owner", deletedAt: null }, data: { name: "New name" } });
    expect((await withDb(() => actions.deleteRepository(id))).success).toBe(true);
    expect(db.gitRepository.updateMany).toHaveBeenCalledWith({ where: { id, ownerId: "owner", deletedAt: null }, data: { deletedAt: expect.any(Date) } });
    expect(namespace.idFromName).toHaveBeenCalledWith(id);
    const request = cleanup.mock.calls[0][0];
    expect([request.method, new URL(request.url).pathname, request.headers.get("x-beutl-git-scope")]).toEqual(["DELETE", "/internal/git/cleanup", "admin"]);
    expect(mocks.revalidate).toHaveBeenCalledTimes(4);
  });
  it("keeps a deletion when storage cleanup is deferred to the scheduled reconciler", async () => {
    cleanup.mockRejectedValueOnce(new Error("object unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await withDb(() => actions.deleteRepository(id))).success).toBe(true);
    expect(mocks.revalidate).toHaveBeenCalledTimes(2);
  });
  it("creates a non-expiring token, stores only its hash, and shows the secret once", async () => {
    const result = await withDb(() => actions.createRepositoryToken(id, " Laptop ", "write"));
    if (!result.success) throw new Error("token was not created");
    expect(result.data).toMatchObject({ id: tokenId, name: "Laptop", scope: "write", lastUsedAt: null });
    expect(result.data.token).toMatch(/^bgt_[A-Za-z0-9_-]{43}$/u);
    expect(result.data).not.toHaveProperty("expiresAt");
    const stored = db.gitAccessToken.create.mock.calls[0][0].data;
    expect(stored).toEqual({ repoId: id, ownerId: "owner", name: "Laptop", scope: "write",
      tokenHash: createHash("sha256").update(result.data.token).digest("hex"), hint: result.data.token.slice(-4) });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it("caps the active tokens per repository", async () => {
    db.gitAccessToken.count.mockResolvedValue(50);
    expect(await withDb(() => actions.createRepositoryToken(id, "Laptop", "read"))).toEqual({ success: false, message: "dashboard:repositories.errors.tokenLimitReached" });
    expect(db.gitAccessToken.create).not.toHaveBeenCalled();
  });
  it("lists active tokens without secrets and revokes one", async () => {
    db.gitAccessToken.findMany.mockResolvedValue([{ id: tokenId, name: "Laptop", scope: "read", hint: "abcd",
      tokenHash: "hash", createdAt, lastUsedAt: createdAt, revokedAt: null }]);
    expect(await withDb(() => actions.listRepositoryTokens(id))).toEqual({ success: true, data: [{ id: tokenId, name: "Laptop",
      scope: "read", hint: "abcd", createdAt: createdAt.toISOString(), lastUsedAt: createdAt.toISOString() }] });
    expect(db.gitAccessToken.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { repoId: id, ownerId: "owner", revokedAt: null } }));
    expect((await withDb(() => actions.revokeRepositoryToken(id, tokenId))).success).toBe(true);
    expect(db.gitAccessToken.updateMany).toHaveBeenCalledWith({ where: { id: tokenId, repoId: id, ownerId: "owner", revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    expect(await withDb(() => actions.revokeRepositoryToken(id, "77777777-7777-4777-8777-777777777777"))).toEqual({ success: false, message: "dashboard:repositories.errors.notFound" });
  });
  it("does not fall back to a remote API without a Worker context", async () => {
    mocks.context.mockRejectedValue(new Error("no context"));
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(await withDb(actions.retrieveRepositories)).toEqual({ success: false, message: "dashboard:repositories.errors.unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reads Git settings only from the Worker bindings", async () => {
    mocks.context.mockResolvedValue({ env: { ...gitEnv, BEUTL_GIT_ENABLED: "false" } });
    vi.stubEnv("BEUTL_GIT_ENABLED", "true");
    expect(await withDb(actions.retrieveRepositories)).toEqual({ success: false, message: "dashboard:repositories.errors.unavailable" });
  });
  it("embeds the token as USER:TOKEN and quotes the clone command against shell metacharacters", () => {
    expect(authenticatedCloneUrl("https://git.example/api/v3/git/repo.git", "bgt_token")).toBe("https://git:bgt_token@git.example/api/v3/git/repo.git");
    expect(repositoryCloneCommand("https://git.example/a'$(touch nope).git", "bgt_token")).toBe("git clone 'https://git:bgt_token@git.example/a'\"'\"'$(touch%20nope).git'");
  });
});
