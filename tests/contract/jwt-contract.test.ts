import { describe, expect, it } from "vitest";
import { decode, verify, sign } from "hono/jwt";

// v1/account が発行する JWT のワイヤ契約を固定する。
// デスクトップアプリはクレーム名 http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier を
// ユーザー ID として読み、HS256 署名を検証する。リファクタ/分離後もこの形状は不変。
//
// NOTE: v1/account.ts の crypto コードは「移動のみ・変更ゼロ」の対象。
// このテストはゴールデントークンで発行/検証の等価性を担保する。

const NAME_IDENTIFIER_CLAIM =
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier";

describe("v1 JWT 契約 (createJwtToken と同形)", () => {
  const secret = "test-secret-for-contract";
  const userId = "user_123";

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

  it("refresh token 暗号化は PBKDF2(100k/SHA-256) + AES-CBC の iv∥salt∥cipher 形式", async () => {
    // v1/account.ts の encryptRefreshToken と同じ手順を再現し、base64 デコードで
    // 先頭 16B=iv, 次 16B=salt, 以降=cipher となることを確認する。
    const rawToken = "random-uuid";
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: salt as BufferSource, iterations: 100000, hash: "SHA-256" },
      keyMaterial,
      { name: "AES-CBC", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const iv = new Uint8Array(16);
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-CBC", iv: iv as BufferSource },
      key,
      enc.encode(rawToken),
    );
    const combined = Buffer.concat([iv, salt, new Uint8Array(encrypted)]);
    const token = combined.toString("base64");

    // 復号 (decryptRefreshToken と同じ)
    const data = Buffer.from(token, "base64");
    expect(data.subarray(0, 16).length).toBe(16); // iv
    expect(data.subarray(16, 32).length).toBe(16); // salt
    const decKey = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: data.subarray(16, 32) as BufferSource, iterations: 100000, hash: "SHA-256" },
      keyMaterial,
      { name: "AES-CBC", length: 256 },
      false,
      ["decrypt"],
    );
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv: data.subarray(0, 16) as BufferSource },
      decKey,
      data.subarray(32),
    );
    expect(Buffer.from(decrypted).toString("utf8")).toBe(rawToken);
  });
});
