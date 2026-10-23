import { afterEach, describe, expect, it } from "vitest";
import { decode, verify, sign } from "hono/jwt";
import {
  getUserIdFromHeaders,
  tryGetUserIdFromHeaders,
} from "../../packages/api/src/api/auth";

// v1/account が発行する JWT のワイヤ契約を固定する。
// デスクトップアプリはクレーム名 http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier を
// ユーザー ID として読み、HS256 署名を検証する。リファクタ/分離後もこの形状は不変。
//
// リフレッシュトークンの暗号形式と改ざん拒否は refresh-token-auth.test.ts で
// 実際の v1/account の発行・更新レスポンスを使って検証する。

const NAME_IDENTIFIER_CLAIM =
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier";

afterEach(() => {
  delete process.env.JWT_SECRET;
  delete process.env.JWT_ISSUER;
  delete process.env.JWT_AUDIENCE;
});

describe("v1 JWT 契約 (createJwtToken と同形)", () => {
  const secret = "test-secret-for-contract";
  const userId = "user_123";

  async function verifyThroughApi(
    payload: Record<string, unknown>,
    options: { secret?: string; algorithm?: "HS256" | "HS512" } = {},
  ) {
    process.env.JWT_SECRET = secret;
    process.env.JWT_ISSUER = "https://beutl.beditor.net";
    process.env.JWT_AUDIENCE = "beutl";
    const token = await sign(
      payload,
      options.secret ?? secret,
      options.algorithm ?? "HS256",
    );
    return await getUserIdFromHeaders(
      new Headers({ Authorization: `Bearer ${token}` }),
    );
  }

  it("クレーム名は xmlsoap nameidentifier で userId を保持する", async () => {
    const token = await sign(
      {
        [NAME_IDENTIFIER_CLAIM]: userId,
        jti: "uuid",
        iss: "https://beutl.beditor.net",
        aud: "beutl",
        exp: Math.floor(Date.now() / 1000) + 300,
        nbf: Math.floor(Date.now() / 1000),
      },
      secret,
      "HS256",
    );

    // decode のみ (getUserIdFromToken 相当)
    const { payload } = decode(token);
    expect(payload[NAME_IDENTIFIER_CLAIM]).toBe(userId);

    // verify (getUserId / verifyBearer 相当)
    const verified = await verify(token, secret, "HS256");
    expect(verified[NAME_IDENTIFIER_CLAIM]).toBe(userId);
  });

  it("HS256 で署名されており、別秘密では検証失敗する", async () => {
    const token = await sign({ [NAME_IDENTIFIER_CLAIM]: userId }, secret, "HS256");
    await expect(verify(token, "wrong-secret", "HS256")).rejects.toThrow();
    await expect(verify(token, secret, "HS256")).resolves.toMatchObject({
      [NAME_IDENTIFIER_CLAIM]: userId,
    });
  });

  it("API verification enforces issuer, audience, and valid NumericDate claims", async () => {
    const now = Math.floor(Date.now() / 1000);
    const valid = {
      [NAME_IDENTIFIER_CLAIM]: userId,
      iss: "https://beutl.beditor.net",
      aud: "beutl",
      iat: now - 1,
      nbf: now - 1,
      exp: now + 300,
    };

    await expect(verifyThroughApi(valid)).resolves.toBe(userId);
    await expect(
      verifyThroughApi({ ...valid, iss: "https://attacker.example" }),
    ).resolves.toBeNull();
    await expect(
      verifyThroughApi({ ...valid, aud: "another-app" }),
    ).resolves.toBeNull();
    await expect(
      verifyThroughApi({ ...valid, exp: now - 1 }),
    ).resolves.toBeNull();
    await expect(
      verifyThroughApi({ ...valid, exp: 0 }),
    ).resolves.toBeNull();
    await expect(
      verifyThroughApi({ ...valid, nbf: now + 60 }),
    ).resolves.toBeNull();
    await expect(
      verifyThroughApi({ ...valid, iat: now + 60 }),
    ).resolves.toBeNull();
  });

  it.each([
    ["exp", "tomorrow"],
    ["nbf", null],
    ["iat", {}],
  ])("rejects a malformed %s claim", async (claim, value) => {
    const now = Math.floor(Date.now() / 1000);
    await expect(
      verifyThroughApi({
        [NAME_IDENTIFIER_CLAIM]: userId,
        iss: "https://beutl.beditor.net",
        aud: "beutl",
        exp: now + 300,
        [claim]: value,
      }),
    ).resolves.toBeNull();
  });

  it.each([undefined, null, 123, "", "   "])(
    "rejects an invalid nameidentifier claim (%s)",
    async (claim) => {
      const now = Math.floor(Date.now() / 1000);
      await expect(
        verifyThroughApi({
          [NAME_IDENTIFIER_CLAIM]: claim,
          iss: "https://beutl.beditor.net",
          aud: "beutl",
          exp: now + 300,
        }),
      ).resolves.toBeNull();
    },
  );

  it("treats bad signatures, algorithms, and malformed bearer values as unauthenticated", async () => {
    const now = Math.floor(Date.now() / 1000);
    const valid = {
      [NAME_IDENTIFIER_CLAIM]: userId,
      iss: "https://beutl.beditor.net",
      aud: "beutl",
      exp: now + 300,
    };

    await expect(
      verifyThroughApi(valid, { secret: "wrong-secret" }),
    ).resolves.toBeNull();
    await expect(
      verifyThroughApi(valid, { algorithm: "HS512" }),
    ).resolves.toBeNull();

    process.env.JWT_SECRET = secret;
    await expect(
      getUserIdFromHeaders(
        new Headers({ Authorization: "Bearer definitely-not-a-jwt" }),
      ),
    ).resolves.toBeNull();
    await expect(
      getUserIdFromHeaders(
        new Headers({ Authorization: "Bearer token with spaces" }),
      ),
    ).resolves.toBeNull();
  });

  it("keeps optional header identity anonymous when JWT configuration is missing", async () => {
    delete process.env.JWT_SECRET;
    const headers = new Headers({ Authorization: "Bearer token" });

    await expect(tryGetUserIdFromHeaders(headers)).resolves.toBeNull();
    await expect(getUserIdFromHeaders(headers)).rejects.toThrow(
      "JWT_SECRET is not configured",
    );
  });

  it("enforces issuer and audience only when configured", async () => {
    process.env.JWT_SECRET = secret;
    const token = await sign(
      {
        [NAME_IDENTIFIER_CLAIM]: userId,
        exp: Math.floor(Date.now() / 1000) + 300,
      },
      secret,
      "HS256",
    );

    await expect(
      getUserIdFromHeaders(
        new Headers({ Authorization: `bearer ${token}` }),
      ),
    ).resolves.toBe(userId);
  });

  it("reports a missing JWT secret as a configuration error", async () => {
    const token = await sign(
      {
        [NAME_IDENTIFIER_CLAIM]: userId,
        exp: Math.floor(Date.now() / 1000) + 300,
      },
      secret,
      "HS256",
    );

    await expect(
      getUserIdFromHeaders(
        new Headers({ Authorization: `Bearer ${token}` }),
      ),
    ).rejects.toThrow("JWT_SECRET is not configured");
  });
});
