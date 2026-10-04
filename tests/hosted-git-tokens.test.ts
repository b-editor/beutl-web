import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runWithDbProvider } from "@beutl/db";
import { findGitAccess } from "../packages/api/src/git/access-tokens";
import { generateGitAccessToken, gitAccessTokenFrom, hashGitAccessToken } from "../packages/api/src/git/tokens";
import { basicCredential, gitAccessTokenDelegate, gitAccessTokenFixture } from "./stubs/git-access-tokens";

const basic = (value: string) => `Basic ${Buffer.from(value).toString("base64")}`;

describe("Git access token credentials", () => {
  it("generates distinct URL-safe tokens and stores only their SHA-256", async () => {
    const tokens = new Set(Array.from({ length: 100 }, generateGitAccessToken));
    expect(tokens.size).toBe(100);
    for (const token of tokens) {
      expect(token).toMatch(/^bgt_[A-Za-z0-9_-]{43}$/u);
      // Git puts the token in the URL user info, which must not need escaping.
      expect(encodeURIComponent(token)).toBe(token);
    }
    const [token] = tokens;
    expect(await hashGitAccessToken(token)).toBe(createHash("sha256").update(token).digest("hex"));
  });

  it("reads the token from USER:TOKEN, a bare user name, or a Bearer credential", () => {
    const token = generateGitAccessToken();
    expect(gitAccessTokenFrom(basic(`git:${token}`))).toBe(token);
    expect(gitAccessTokenFrom(basic(`ユーザー:${token}`))).toBe(token);
    expect(gitAccessTokenFrom(basic(token))).toBe(token);
    expect(gitAccessTokenFrom(basic(`${token}:`))).toBe(token);
    expect(gitAccessTokenFrom(`Bearer ${token}`)).toBe(token);
    expect(gitAccessTokenFrom(`bearer\t${token} `)).toBe(token);
  });

  it.each([
    ["no header", null],
    ["an unknown scheme", "Token bgt_x"],
    ["malformed Basic data", "Basic !!!"],
    ["a password that is not a token", basic("git:password")],
    ["an API JWT", "Bearer eyJhbGciOiJIUzI1NiJ9.e30.signature"],
    ["a truncated token", `Bearer ${generateGitAccessToken().slice(0, -1)}`],
  ])("treats %s as no credential", (_case, header) => {
    expect(gitAccessTokenFrom(header)).toBeNull();
  });

  it("grants only the read and write scopes it issues", async () => {
    const repoId = "12345678-1234-1234-1234-123456789abc";
    const read = await gitAccessTokenFixture({ repoId, scope: "read" });
    const unknown = await gitAccessTokenFixture({ repoId });
    const db = { gitAccessToken: gitAccessTokenDelegate([read.row, { ...unknown.row, scope: "admin" as never }]) };
    await runWithDbProvider(async () => db as never, async () => {
      expect(await findGitAccess(basicCredential(read.token), repoId)).toEqual({ ownerId: "owner", scope: "read", active: true });
      expect(await findGitAccess(basicCredential(unknown.token), repoId)).toBeNull();
    });
  });
});
