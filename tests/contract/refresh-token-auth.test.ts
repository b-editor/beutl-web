import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { decode, sign } from "hono/jwt";
import { createSessionPrisma } from "../stubs/session-prisma";

const NAME_IDENTIFIER_CLAIM =
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier";
const NOW = new Date("2026-08-09T00:00:00.000Z");

vi.mock("@beutl/i18n", () => ({
  getTranslation: async () => ({ t: (key: string) => key }),
}));

import {
  REFRESH_TOKEN_FAMILY_MAX_LIFETIME_MS,
  REFRESH_TOKEN_RESPONSE_LOSS_GRACE_MS,
  setDbProvider,
} from "@beutl/db";
import account from "../../packages/api/src/v1/account";

async function post(path: string, body: Record<string, unknown>) {
  return await account.request(`https://beutl.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

type Credentials = {
  token: string;
  refresh_token: string;
};

// Decode actual API output with an independent implementation of the wire format.
function decryptGcmRefreshToken(token: string) {
  expect(token).toMatch(/^v2\./);
  const data = Buffer.from(token.slice(3), "base64");
  const key = pbkdf2Sync(
    "refresh-test-secret",
    data.subarray(12, 28),
    100_000,
    32,
    "sha256",
  );
  const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  decipher.setAAD(Buffer.from("beutl:refresh-token:v2"));
  decipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([
    decipher.update(data.subarray(28, -16)),
    decipher.final(),
  ]).toString("utf8");
}

describe("v1 refresh-token rotation", () => {
  let store: ReturnType<typeof createSessionPrisma>;

  async function issueCredentials(userId: string): Promise<Credentials> {
    store.putNativeAppAuth({
      id: "native-auth",
      code: "authorization-code",
      codeExpires: new Date(Date.now() + 60_000),
      continueUrl: "https://app.example/continue",
      sessionId: "native-session",
      userId,
    });
    const response = await post("/code2jwt", {
      code: "authorization-code",
      session_id: "native-session",
    });
    expect(response.status).toBe(200);
    return (await response.json()) as Credentials;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    store = createSessionPrisma();
    setDbProvider(async () => store.prisma as never);
    process.env.JWT_SECRET = "refresh-test-secret";
    process.env.JWT_ISSUER = "https://beutl.example";
    process.env.JWT_AUDIENCE = "beutl";
    process.env.JWT_EXPIRATION_MINUTES = "5";
    process.env.JWT_REFRESH_TOKEN_EXPIRATION_DAYS = "30";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.JWT_SECRET;
    delete process.env.JWT_ISSUER;
    delete process.env.JWT_AUDIENCE;
    delete process.env.JWT_EXPIRATION_MINUTES;
    delete process.env.JWT_REFRESH_TOKEN_EXPIRATION_DAYS;
  });

  it("stores the initial native refresh token outside Better Auth sessions", async () => {
    const credentials = await issueCredentials("session-owner");

    expect(store.all()).toHaveLength(1);
    expect(decryptGcmRefreshToken(credentials.refresh_token)).toBe(
      store.all()[0].token,
    );
    expect(store.allSessions()).toHaveLength(0);
    expect(store.all()[0]).toMatchObject({
      userId: "session-owner",
      refreshTokenFamilyId: expect.any(String),
      refreshTokenConsumedAt: null,
      refreshTokenReplacedByToken: null,
    });
    expect(store.allFamilies()).toHaveLength(1);
    expect(store.allFamilies()[0]).toMatchObject({
      userId: "session-owner",
      revokedAt: null,
    });
  });

  it.each([
    ["IV", 0],
    ["salt", 12],
    ["ciphertext", 28],
    ["authentication tag", 64],
  ])("rejects a modified %s before accessing the database", async (_, offset) => {
    const credentials = await issueCredentials("session-owner");
    const data = Buffer.from(credentials.refresh_token.slice(3), "base64");
    data[offset] ^= 1;
    const getDb = vi.fn(async () => store.prisma as never);
    setDbProvider(getDb);

    const response = await post("/refresh", {
      refresh_token: `v2.${data.toString("base64")}`,
      token: credentials.token,
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error_code: "invalidRefreshToken",
    });
    expect(getDb).not.toHaveBeenCalled();
    expect(store.all()[0].refreshTokenConsumedAt).toBeNull();
    expect(store.allFamilies()[0].revokedAt).toBeNull();
  });

  it.each([
    ["missing version", (token: string) => token.slice(3)],
    ["unsupported version", (token: string) => token.replace("v2.", "v3.")],
    ["empty payload", () => "v2."],
    ["truncated header", () => `v2.${Buffer.alloc(27).toString("base64")}`],
    ["missing ciphertext", () => `v2.${Buffer.alloc(44).toString("base64")}`],
    ["invalid base64", (token: string) => `${token}!`],
    ["base64 whitespace", (token: string) => `${token}\n`],
    ["missing padding", (token: string) => token.replace(/=+$/, "")],
  ])("rejects malformed %s before key derivation or DB access", async (_, mutate) => {
    const credentials = await issueCredentials("session-owner");
    const deriveKey = vi.spyOn(crypto.subtle, "deriveKey");
    const getDb = vi.fn(async () => store.prisma as never);
    setDbProvider(getDb);

    const response = await post("/refresh", {
      refresh_token: mutate(credentials.refresh_token),
      token: credentials.token,
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error_code: "invalidRefreshToken",
    });
    expect(deriveKey).not.toHaveBeenCalled();
    expect(getDb).not.toHaveBeenCalled();
  });

  it.each(["truncated", "extended"])("rejects a %s tag", async (change) => {
    const credentials = await issueCredentials("session-owner");
    const data = Buffer.from(credentials.refresh_token.slice(3), "base64");
    const malformed =
      change === "truncated"
        ? data.subarray(0, -1)
        : Buffer.concat([data, Buffer.from([0])]);
    const getDb = vi.fn(async () => store.prisma as never);
    setDbProvider(getDb);

    const response = await post("/refresh", {
      refresh_token: `v2.${malformed.toString("base64")}`,
      token: credentials.token,
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error_code: "invalidRefreshToken",
    });
    expect(getDb).not.toHaveBeenCalled();
  });

  it("rejects a token encrypted with another secret before accessing the database", async () => {
    const credentials = await issueCredentials("session-owner");
    process.env.JWT_SECRET = "another-secret";
    const getDb = vi.fn(async () => store.prisma as never);
    setDbProvider(getDb);

    const response = await post("/refresh", {
      refresh_token: credentials.refresh_token,
      token: credentials.token,
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error_code: "invalidRefreshToken",
    });
    expect(getDb).not.toHaveBeenCalled();
  });

  it.each(["", "v2."])("rejects legacy CBC with prefix '%s'", async (prefix) => {
    // Golden token from the old PBKDF2/SHA-256 + AES-CBC wire format, using
    // refresh-test-secret, a zero IV, and salt 00112233445566778899aabbccddeeff.
    const legacyToken =
      "AAAAAAAAAAAAAAAAAAAAAAARIjNEVWZ3iJmqu8zd7v8P5KuyLiTiOsVNEXmBbqTD19lPfbrIZTC+C4QFj6tr+W9Y7TowogebHXQ3qIp051s=";
    store = createSessionPrisma([
      {
        token: "00000000-0000-4000-8000-000000000001",
        userId: "legacy-owner",
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);
    const getDb = vi.fn(async () => store.prisma as never);
    setDbProvider(getDb);

    const response = await post("/refresh", {
      refresh_token: `${prefix}${legacyToken}`,
      token: "unused-access-token",
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error_code: "invalidRefreshToken",
    });
    expect(getDb).not.toHaveBeenCalled();
    expect(store.allSessions()).toHaveLength(1);
    expect(store.all()).toHaveLength(0);
    expect(store.allFamilies()).toHaveLength(0);
  });

  it.each([undefined, ""])("returns 500 for JWT secret '%s'", async (secret) => {
    const credentials = await issueCredentials("session-owner");
    if (secret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = secret;
    }
    const getDb = vi.fn(async () => store.prisma as never);
    setDbProvider(getDb);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await post("/refresh", {
      refresh_token: credentials.refresh_token,
      token: credentials.token,
    });

    expect(response.status).toBe(500);
    expect(getDb).not.toHaveBeenCalled();
    expect(store.all()[0].refreshTokenConsumedAt).toBeNull();
  });

  it("caps the initial refresh-token lifetime at 90 days", async () => {
    process.env.JWT_REFRESH_TOKEN_EXPIRATION_DAYS = "120";

    await issueCredentials("session-owner");

    const absoluteExpiry = new Date(
      NOW.getTime() + REFRESH_TOKEN_FAMILY_MAX_LIFETIME_MS,
    );
    expect(store.allFamilies()[0].expiresAt).toEqual(absoluteExpiry);
    expect(store.all()[0].expiresAt).toEqual(absoluteExpiry);
  });

  it("adopts a pre-deployment native session on its first refresh", async () => {
    const credentials = await issueCredentials("legacy-session-owner");
    const legacySession = store.all()[0];
    const oldFamilyId = legacySession.refreshTokenFamilyId!;
    store.moveNativeTokenToLegacySession(legacySession.token);
    store.deleteFamily(oldFamilyId);
    expect(store.all()).toHaveLength(0);
    expect(store.allSessions()).toHaveLength(1);

    const response = await post("/refresh", {
      refresh_token: credentials.refresh_token,
      token: credentials.token,
    });

    expect(response.status).toBe(200);
    expect(store.all()).toHaveLength(2);
    expect(store.allSessions()).toHaveLength(0);
    const adoptedParent = store.get(legacySession.token);
    expect(adoptedParent).toMatchObject({
      userId: "legacy-session-owner",
      refreshTokenFamilyId: expect.any(String),
      refreshTokenConsumedAt: NOW,
    });
    expect(
      store.get(adoptedParent!.refreshTokenReplacedByToken!),
    ).toMatchObject({
      userId: "legacy-session-owner",
      refreshTokenFamilyId: adoptedParent!.refreshTokenFamilyId,
      refreshTokenConsumedAt: null,
    });
    expect(store.allTransactionOptions().at(-1)).toEqual({
      isolationLevel: "Serializable",
    });
  });

  it.each(["0", "-1", "invalid"])(
    "rejects an invalid refresh-token expiration of %s days",
    async (expirationDays) => {
      process.env.JWT_REFRESH_TOKEN_EXPIRATION_DAYS = expirationDays;
      store.putNativeAppAuth({
        id: "native-auth",
        code: "authorization-code",
        codeExpires: new Date(Date.now() + 60_000),
        continueUrl: "https://app.example/continue",
        sessionId: "native-session",
        userId: "session-owner",
      });
      const log = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const response = await post("/code2jwt", {
          code: "authorization-code",
          session_id: "native-session",
        });

        expect(response.status).toBe(500);
        expect(store.allFamilies()).toHaveLength(0);
        expect(store.all()).toHaveLength(0);
      } finally {
        log.mockRestore();
      }
    },
  );

  it("ignores a forged victim claim and mints for the session owner", async () => {
    const credentials = await issueCredentials("session-owner");
    const forgedVictimToken = await sign(
      { [NAME_IDENTIFIER_CLAIM]: "victim" },
      process.env.JWT_SECRET as string,
    );

    const response = await post("/refresh", {
      refresh_token: credentials.refresh_token,
      token: forgedVictimToken,
    });

    expect(response.status).toBe(200);
    const refreshed = (await response.json()) as { token: string };
    expect(decode(refreshed.token).payload[NAME_IDENTIFIER_CLAIM]).toBe(
      "session-owner",
    );
  });

  it("rejects an expired refresh session", async () => {
    const credentials = await issueCredentials("session-owner");
    const session = store.all()[0];
    store.update(session.token, {
      expiresAt: new Date(Date.now() - 1),
    });
    const encrypt = vi.spyOn(crypto.subtle, "encrypt");

    try {
      const response = await post("/refresh", {
        refresh_token: credentials.refresh_token,
        token: credentials.token,
      });

      expect(response.status).toBe(401);
      expect(store.all()).toHaveLength(1);
      expect(encrypt).not.toHaveBeenCalled();
    } finally {
      encrypt.mockRestore();
    }
  });

  it("returns one child to concurrent legacy refresh callers", async () => {
    const credentials = await issueCredentials("session-owner");
    const legacySession = store.all()[0];
    const oldFamilyId = legacySession.refreshTokenFamilyId!;
    store.moveNativeTokenToLegacySession(legacySession.token);
    store.deleteFamily(oldFamilyId);
    const body = {
      refresh_token: credentials.refresh_token,
      token: credentials.token,
    };

    const responses = await Promise.all([
      post("/refresh", body),
      post("/refresh", body),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(store.all()).toHaveLength(2);
    expect(store.allSessions()).toHaveLength(0);
    expect(
      store.all().filter((session) => !session.refreshTokenConsumedAt),
    ).toHaveLength(1);
  });

  it("does not adopt a plaintext Better Auth browser session", async () => {
    store = createSessionPrisma([
      {
        token: "better-auth-browser-token",
        userId: "browser-user",
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);
    setDbProvider(async () => store.prisma as never);
    const before = store.getSession("better-auth-browser-token");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const response = await post("/refresh", {
        refresh_token: "better-auth-browser-token",
        token: "unused-browser-access-token",
      });

      expect(response.status).toBe(401);
      expect(store.getSession("better-auth-browser-token")).toEqual(before);
      expect(store.allSessions()).toHaveLength(1);
      expect(store.all()).toHaveLength(0);
    } finally {
      log.mockRestore();
    }
  });

  it("reuses the child for a bounded response-loss retry", async () => {
    const credentials = await issueCredentials("session-owner");
    const body = {
      refresh_token: credentials.refresh_token,
      token: credentials.token,
    };

    const first = await post("/refresh", body);
    vi.setSystemTime(
      new Date(NOW.getTime() + REFRESH_TOKEN_RESPONSE_LOSS_GRACE_MS),
    );
    const retry = await post("/refresh", body);

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    const firstCredentials = (await first.json()) as Credentials;
    const retryCredentials = (await retry.json()) as Credentials;
    const replacement = store.all().find(
      (session) => !session.refreshTokenConsumedAt,
    )!;
    expect(decryptGcmRefreshToken(firstCredentials.refresh_token)).toBe(
      replacement.token,
    );
    expect(decryptGcmRefreshToken(retryCredentials.refresh_token)).toBe(
      replacement.token,
    );
    // Even when wrapping the same raw token, every response uses fresh randomness.
    const firstData = Buffer.from(firstCredentials.refresh_token.slice(3), "base64");
    const retryData = Buffer.from(retryCredentials.refresh_token.slice(3), "base64");
    expect(firstData.subarray(0, 12)).not.toEqual(retryData.subarray(0, 12));
    expect(firstData.subarray(12, 28)).not.toEqual(retryData.subarray(12, 28));
    expect(store.all()).toHaveLength(2);
    expect(
      store.all().filter((session) => !session.refreshTokenConsumedAt),
    ).toHaveLength(1);
  });

  it("extends only the family record when rotating repeatedly", async () => {
    const credentials = await issueCredentials("session-owner");
    const original = store.all()[0];

    const firstResponse = await post("/refresh", {
      refresh_token: credentials.refresh_token,
      token: credentials.token,
    });
    expect(firstResponse.status).toBe(200);
    const firstCredentials = (await firstResponse.json()) as Credentials;
    const firstChild = store
      .all()
      .find((session) => !session.refreshTokenConsumedAt)!;
    const firstChildExpiresAt = firstChild.expiresAt;

    vi.setSystemTime(new Date(NOW.getTime() + 24 * 60 * 60 * 1000));
    const secondResponse = await post("/refresh", {
      refresh_token: firstCredentials.refresh_token,
      token: firstCredentials.token,
    });

    expect(secondResponse.status).toBe(200);
    expect(store.allSessions()).toHaveLength(0);
    expect(store.get(original.token)?.expiresAt).toEqual(original.expiresAt);
    expect(store.get(firstChild.token)?.expiresAt).toEqual(firstChildExpiresAt);
    expect(
      store.getFamily(original.refreshTokenFamilyId!)?.expiresAt,
    ).toEqual(new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1000));
  });

  it("caps a refresh-token family at 90 days from creation", async () => {
    const credentials = await issueCredentials("session-owner");
    const original = store.all()[0];
    const familyId = original.refreshTokenFamilyId;
    store.updateFamily(familyId, {
      createdAt: new Date(
        NOW.getTime() -
          REFRESH_TOKEN_FAMILY_MAX_LIFETIME_MS +
          24 * 60 * 60 * 1000,
      ),
    });

    const response = await post("/refresh", {
      refresh_token: credentials.refresh_token,
      token: credentials.token,
    });

    expect(response.status).toBe(200);
    const refreshed = (await response.json()) as Credentials;
    const absoluteExpiry = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    expect(store.getFamily(familyId)?.expiresAt).toEqual(absoluteExpiry);
    expect(
      store.all().find((token) => !token.refreshTokenConsumedAt)?.expiresAt,
    ).toEqual(absoluteExpiry);

    vi.setSystemTime(absoluteExpiry);
    const expiredResponse = await post("/refresh", {
      refresh_token: refreshed.refresh_token,
      token: refreshed.token,
    });

    expect(expiredResponse.status).toBe(401);
    expect(store.getFamily(familyId)).toBeNull();
    expect(store.all()).toHaveLength(0);
  });

  it("retains tombstones until token expiry and then purges them", async () => {
    const initialCredentials = await issueCredentials("session-owner");
    const original = store.all()[0];

    const firstResponse = await post("/refresh", {
      refresh_token: initialCredentials.refresh_token,
      token: initialCredentials.token,
    });
    const firstCredentials = (await firstResponse.json()) as Credentials;

    vi.setSystemTime(new Date(NOW.getTime() + 29 * 24 * 60 * 60 * 1000));
    const secondResponse = await post("/refresh", {
      refresh_token: firstCredentials.refresh_token,
      token: firstCredentials.token,
    });
    expect(secondResponse.status).toBe(200);
    const secondCredentials = (await secondResponse.json()) as Credentials;
    expect(store.get(original.token)).not.toBeNull();

    vi.setSystemTime(new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1000));
    const thirdResponse = await post("/refresh", {
      refresh_token: secondCredentials.refresh_token,
      token: secondCredentials.token,
    });

    expect(thirdResponse.status).toBe(200);
    expect(store.get(original.token)).toBeNull();
    expect(store.all()).toHaveLength(2);
  });

  it("purges one expired family when issuing new credentials", async () => {
    await issueCredentials("expired-family-owner");
    const expiredFamily = store.allFamilies()[0];
    store.updateFamily(expiredFamily.id, {
      expiresAt: new Date(NOW.getTime() - 1),
    });

    await issueCredentials("new-family-owner");

    expect(store.getFamily(expiredFamily.id)).toBeNull();
    expect(store.allFamilies()).toHaveLength(1);
    expect(store.allFamilies()[0].userId).toBe("new-family-owner");
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0].userId).toBe("new-family-owner");
  });

  it("revokes the family when the parent is replayed after grace", async () => {
    const credentials = await issueCredentials("session-owner");
    const body = {
      refresh_token: credentials.refresh_token,
      token: credentials.token,
    };
    const attackerResponse = await post("/refresh", body);
    const attackerCredentials =
      (await attackerResponse.json()) as Credentials;
    vi.setSystemTime(
      new Date(NOW.getTime() + REFRESH_TOKEN_RESPONSE_LOSS_GRACE_MS + 1),
    );

    expect((await post("/refresh", body)).status).toBe(401);
    expect(
      store.getFamily(store.all()[0].refreshTokenFamilyId!)?.revokedAt,
    ).toEqual(
      new Date(NOW.getTime() + REFRESH_TOKEN_RESPONSE_LOSS_GRACE_MS + 1),
    );
    expect(
      (
        await post("/refresh", {
          refresh_token: attackerCredentials.refresh_token,
          token: attackerCredentials.token,
        })
      ).status,
    ).toBe(401);
  });
});
