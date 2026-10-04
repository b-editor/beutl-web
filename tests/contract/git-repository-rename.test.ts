import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sign } from "hono/jwt";
import { runWithDbProvider, type PrismaClient } from "@beutl/db";
import { routeGitRequest, type GitRouterEnvironment } from "@beutl/api/git/router";

const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const row = { id, ownerId: "owner", name: "Project", createdAt: new Date("2026-10-04T00:00:00Z"), updatedAt: new Date("2026-10-04T00:00:00Z") };
const findFirst = vi.fn();
const update = vi.fn();
const db = { gitRepository: { findFirst, update } } as unknown as PrismaClient;
const env: GitRouterEnvironment = {
  BEUTL_GIT_ENABLED: "true", BEUTL_GIT_TOKEN_SECRET: "git-test-secret-at-least-thirty-two-characters",
  BEUTL_GIT_S3_ENDPOINT: "https://s3.example", BEUTL_GIT_S3_REGION: "test",
  BEUTL_GIT_S3_BUCKET: "test", BEUTL_GIT_S3_ACCESS_KEY_ID: "test", BEUTL_GIT_S3_SECRET_ACCESS_KEY: "test",
  BEUTL_GIT_REPOSITORIES: { idFromName: (name) => name, get: () => ({ fetch: async () => new Response(null, { status: 204 }) }) },
};

async function rename(body: unknown, owner = "owner", raw = false) {
  const token = await sign({ "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier": owner, exp: Math.floor(Date.now() / 1000) + 60 }, process.env.JWT_SECRET!, "HS256");
  return runWithDbProvider(async () => db, () => routeGitRequest(new Request(`https://git.example/api/v3/repos/${id}`, {
    method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: raw ? String(body) : JSON.stringify(body),
  }), env));
}

beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("JWT_SECRET", "api-test-secret");
  vi.stubEnv("JWT_ISSUER", ""); vi.stubEnv("JWT_AUDIENCE", "");
  findFirst.mockImplementation(async ({ where }) => where.ownerId === row.ownerId ? row : null);
  update.mockImplementation(async ({ data }) => ({ ...row, ...data }));
});
afterEach(() => vi.unstubAllEnvs());

describe("repository name changes", () => {
  it("renames an active owned repository without changing its clone URL or identity", async () => {
    const response = await rename({ name: " 新しいプロジェクト ", ownerId: "someone-else" });
    expect(response!.status).toBe(200);
    expect(await response!.json()).toMatchObject({ id, name: "新しいプロジェクト", url: `https://git.example/api/v3/git/${id}.git` });
    expect(update).toHaveBeenCalledWith({ where: { id, ownerId: "owner", deletedAt: null }, data: { name: "新しいプロジェクト" } });
    expect(response!.headers.get("cache-control")).toBe("no-store");
  });
  it("hides another account's repository and never updates it", async () => {
    expect((await rename({ name: "Attempt" }, "other-owner"))!.status).toBe(404);
    expect(findFirst).toHaveBeenCalledWith({ where: { id, ownerId: "other-owner", deletedAt: null } });
    expect(update).not.toHaveBeenCalled();
  });
  it("does not revive a repository deleted between the lookup and update", async () => {
    update.mockRejectedValue({ code: "P2025" });
    expect((await rename({ name: "New" }))!.status).toBe(404);
    expect(update.mock.calls[0][0].where.deletedAt).toBeNull();
  });
  it.each([null, {}, { name: "a/b" }, { name: "\u007f" }, { name: "x".repeat(81) }])("rejects invalid name input %j", async (body) => {
    expect((await rename(body))!.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });
  it("reports malformed JSON without changing the record", async () => {
    expect((await rename("{", "owner", true))!.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });
});
