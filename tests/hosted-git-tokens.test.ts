import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateGitAccessToken, gitAccessTokenFrom, hashGitAccessToken } from "../packages/api/src/git/tokens";

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
});
