import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { verify } from "hono/jwt";
import { isValidGitRepositoryName } from "@beutl/core";
import { runWithDbProvider } from "@beutl/db";
import { repositoryCloneCommand } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/repositories/connection";

const mocks = vi.hoisted(() => ({ context: vi.fn(), route: vi.fn(), revalidate: vi.fn(), signedIn: true }));
vi.mock("server-only", () => ({}));
vi.mock("@beutl/api/git/router", () => ({ routeGitRequest: mocks.route }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@beutl/next/language", () => ({ getLanguage: async () => "ja" }));
vi.mock("@beutl/i18n", () => ({ getTranslation: async () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/auth-guard", () => ({
  authenticated: async (run: (session: unknown) => unknown) => mocks.signedIn
    ? run({ user: { id: "owner" } }) : { success: false, message: "Unauthenticated" },
}));

let actions: typeof import("../../apps/web/src/app/[lang]/(dashboard)/dashboard/repositories/actions");
let request: typeof import("../../apps/web/src/lib/git-repositories").gitRepositoryRequest;
const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const repository = { id, name: "Project", url: `https://git.example/api/v3/git/${id}.git`, createdAt: "2026-10-04T00:00:00Z", updatedAt: "2026-10-04T00:00:00Z" };
const repositoryOperations = [
  { name: "rename", run: () => actions.renameRepository(id, "New name") },
  { name: "delete", run: () => actions.deleteRepository(id) },
  { name: "token", run: () => actions.createRepositoryToken(id, "read") },
];

beforeAll(async () => {
  const fromWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));
  vi.doMock(fromWeb.resolve("@opennextjs/cloudflare"), () => ({ getCloudflareContext: mocks.context }));
  actions = await import("../../apps/web/src/app/[lang]/(dashboard)/dashboard/repositories/actions");
  ({ gitRepositoryRequest: request } = await import("../../apps/web/src/lib/git-repositories"));
});
beforeEach(() => {
  vi.clearAllMocks(); mocks.signedIn = true;
  vi.stubEnv("JWT_SECRET", "test-service-signing-secret");
  vi.stubEnv("JWT_ISSUER", "web"); vi.stubEnv("JWT_AUDIENCE", "api");
  vi.stubEnv("PUBLIC_ORIGIN", "https://git.example");
  vi.stubEnv("BEUTL_GIT_API_ORIGIN", "");
  mocks.context.mockReturnValue({ env: { BEUTL_GIT_ENABLED: "true", BEUTL_GIT_REPOSITORIES: {} } });
  mocks.route.mockImplementation(async () => Response.json(repository));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("Web repository management", () => {
  it("uses the session identity in a signed, short-lived in-process request without cookies", async () => {
    mocks.route.mockResolvedValue(Response.json({ repositories: [repository] }));
    expect(await actions.retrieveRepositories()).toEqual({ success: true, data: [repository] });
    const outgoing: Request = mocks.route.mock.calls[0][0];
    expect(outgoing.url).toBe("https://git.example/api/v3/repos");
    expect(outgoing.headers.get("cookie")).toBeNull();
    expect(outgoing.headers.get("cache-control")).toBe("no-store");
    const payload = await verify(outgoing.headers.get("authorization")!.slice(7), process.env.JWT_SECRET!, { alg: "HS256", iss: "web", aud: "api" });
    expect(payload["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier"]).toBe("owner");
    expect(Number(payload.exp) - Number(payload.iat)).toBe(60);
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it("does not call the API for an anonymous session or a changed account", async () => {
    mocks.signedIn = false;
    expect(await actions.retrieveRepositories()).toEqual({ success: false, message: "dashboard:repositories.errors.unauthorized" });
    mocks.signedIn = true;
    expect(await actions.createRepository("Project", id, "someone-else")).toMatchObject({ success: false, message: "dashboard:repositories.errors.accountChanged" });
    expect(mocks.route).not.toHaveBeenCalled();
  });
  it("keeps the creation identifier and derives the owner for retries", async () => {
    mocks.route.mockRejectedValueOnce(new Error("connection lost"));
    expect((await actions.createRepository(" Project ", id, "owner")).success).toBe(false);
    expect((await actions.createRepository(" Project ", id, "owner")).success).toBe(true);
    for (const [outgoing] of mocks.route.mock.calls) {
      expect(await outgoing.json()).toEqual({ name: "Project", creationId: id, ownerId: "owner" });
    }
    expect(mocks.revalidate.mock.calls).toEqual([["/ja/dashboard/repositories"], ["/ja/dashboard/storage"]]);
  });
  it.each(["", "  ", "a/b", "a\\b", "a\u0000b", "\u0085", "a\u009fb", "x".repeat(81)])("rejects an invalid name before mutation: %j", async (name) => {
    expect(isValidGitRepositoryName(name)).toBe(false);
    expect((await actions.createRepository(name, id, "owner")).success).toBe(false);
    expect((await actions.renameRepository(id, name)).success).toBe(false);
    expect(mocks.route).not.toHaveBeenCalled();
  });
  it("rejects path traversal, a nil creation ID, and unsupported token scopes", async () => {
    expect((await actions.deleteRepository("../repos")).success).toBe(false);
    expect((await actions.createRepository("Project", "00000000-0000-0000-0000-000000000000", "owner")).success).toBe(false);
    expect((await actions.createRepositoryToken(id, "admin" as "read")).success).toBe(false);
    expect(mocks.route).not.toHaveBeenCalled();
  });
  it.each([[404, "unavailable"], [503, "unavailable"], [401, "unauthorized"], [500, "requestFailed"]])("distinguishes HTTP %i from an empty list", async (status, code) => {
    mocks.route.mockResolvedValue(new Response(null, { status: Number(status) }));
    expect(await actions.retrieveRepositories()).toEqual({ success: false, message: `dashboard:repositories.errors.${code}` });
    mocks.route.mockResolvedValue(Response.json({ repositories: [] }));
    expect(await actions.retrieveRepositories()).toEqual({ success: true, data: [] });
  });
  it.each(repositoryOperations)("reports a disabled Git service as unavailable during $name", async ({ run }) => {
    const { routeGitRequest } = await vi.importActual<typeof import("@beutl/api/git/router")>("@beutl/api/git/router");
    mocks.route.mockImplementationOnce(routeGitRequest);
    mocks.context.mockReturnValue({ env: { BEUTL_GIT_ENABLED: "false" } });
    expect(await run()).toEqual({ success: false, message: "dashboard:repositories.errors.unavailable" });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it.each(repositoryOperations)("reports a missing repository as not found during $name when Git is enabled", async ({ run }) => {
    mocks.route.mockResolvedValue(new Response(null, { status: 404 }));
    expect(await run()).toEqual({ success: false, message: "dashboard:repositories.errors.notFound" });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it("reports the repository cap without refreshing paths on failure", async () => {
    mocks.route.mockResolvedValue(Response.json({ message: "Repository limit reached" }, { status: 409 }));
    expect(await actions.createRepository("Project", id, "owner")).toMatchObject({ success: false, message: "dashboard:repositories.errors.limitReached" });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it("renames and deletes through the shared Git router, revalidating only successful mutations", async () => {
    expect((await actions.renameRepository(id, " New name ")).success).toBe(true);
    const patch: Request = mocks.route.mock.calls[0][0];
    expect(patch.method).toBe("PATCH"); expect(await patch.json()).toEqual({ name: "New name" });
    expect(patch.url).toBe(`https://git.example/api/v3/repos/${id}`);
    mocks.route.mockResolvedValue(new Response(null, { status: 204 }));
    expect((await actions.deleteRepository(id)).success).toBe(true);
    expect(mocks.route.mock.calls[1][0].method).toBe("DELETE");
    expect(mocks.revalidate).toHaveBeenCalledTimes(4);
  });
  it("requests a repository-scoped token without cache revalidation", async () => {
    const credential = { token: "ephemeral-token", expiresAt: "2026-10-04T01:00:00Z" };
    mocks.route.mockResolvedValue(Response.json(credential));
    expect(await actions.createRepositoryToken(id, "read")).toEqual({ success: true, data: credential });
    const outgoing: Request = mocks.route.mock.calls[0][0];
    expect(outgoing.url).toBe(`https://git.example/api/v3/repos/${id}/token`);
    expect(await outgoing.json()).toEqual({ scope: "read" });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it("does not fall back to a remote API or a development override in production", async () => {
    mocks.context.mockImplementation(() => { throw new Error("no context"); });
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("BEUTL_GIT_API_ORIGIN", "https://remote.example");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(request("owner")).rejects.toMatchObject({ code: "unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses the Web binding directly without network or an API service binding", async () => {
    const namespace = { idFromName: vi.fn(), get: vi.fn() };
    mocks.context.mockReturnValue({ env: { BEUTL_GIT_REPOSITORIES: namespace, BEUTL_GIT_ENABLED: "true" } });
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await request("owner");
    expect(mocks.route.mock.calls[0][1]).toMatchObject({ BEUTL_GIT_REPOSITORIES: namespace, BEUTL_GIT_ENABLED: "true" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("lists the owner's repositories through the real router inside Web", async () => {
    const { routeGitRequest } = await vi.importActual<typeof import("@beutl/api/git/router")>("@beutl/api/git/router");
    mocks.route.mockImplementationOnce(routeGitRequest);
    mocks.context.mockReturnValue({ env: {
      BEUTL_GIT_ENABLED: "true", BEUTL_GIT_REPOSITORIES: {},
      BEUTL_GIT_S3_ENDPOINT: "https://s3.example", BEUTL_GIT_S3_REGION: "test-region",
      BEUTL_GIT_S3_BUCKET: "git", BEUTL_GIT_S3_ACCESS_KEY_ID: "test-key",
      BEUTL_GIT_S3_SECRET_ACCESS_KEY: "test-secret", BEUTL_GIT_TOKEN_SECRET: "test-git-signing-secret-at-least-32-characters",
      PUBLIC_ORIGIN: "https://git.example",
    } });
    const findMany = vi.fn().mockResolvedValue([{ ...repository,
      createdAt: new Date(repository.createdAt), updatedAt: new Date(repository.updatedAt),
    }]);
    const db = { gitRepository: { findMany } };
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const result = await runWithDbProvider(async () => db as never, actions.retrieveRepositories);
    expect(result).toMatchObject({ success: true, data: [{ id, name: "Project", url: repository.url }] });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { ownerId: "owner", deletedAt: null } }));
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reads local Git settings from .env while preserving the Durable Object binding", async () => {
    const namespace = { idFromName: vi.fn(), get: vi.fn() };
    mocks.context.mockReturnValue({ env: { BEUTL_GIT_REPOSITORIES: namespace, BEUTL_GIT_ENABLED: "false" } });
    vi.stubEnv("NODE_ENV", "development"); vi.stubEnv("BEUTL_GIT_ENABLED", "true");
    vi.stubEnv("BEUTL_GIT_TOKEN_SECRET", "local-git-signing-secret");
    await request("owner");
    expect(mocks.context).toHaveBeenCalledWith({ async: true });
    expect(mocks.route.mock.calls[0][1]).toMatchObject({ BEUTL_GIT_REPOSITORIES: namespace, BEUTL_GIT_ENABLED: "true", BEUTL_GIT_TOKEN_SECRET: "local-git-signing-secret" });
  });
  it("keeps production Git settings in the Web Worker bindings", async () => {
    mocks.context.mockReturnValue({ env: { BEUTL_GIT_ENABLED: "false" } });
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("BEUTL_GIT_ENABLED", "true");
    await request("owner");
    expect(mocks.route.mock.calls[0][1].BEUTL_GIT_ENABLED).toBe("false");
  });
  it("quotes the Bearer clone command without executing URL shell metacharacters", () => {
    expect(repositoryCloneCommand("https://git.example/a'$(touch nope).git", "abc.def")).toBe("git -c 'http.extraHeader=Authorization: Bearer abc.def' clone 'https://git.example/a'\"'\"'$(touch nope).git'");
  });
});
