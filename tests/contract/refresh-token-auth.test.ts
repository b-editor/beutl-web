import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decode, sign } from "hono/jwt";
import { createSessionPrisma } from "../stubs/session-prisma";

const NAME_IDENTIFIER_CLAIM =
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier";
const NOW = new Date("2026-08-09T00:00:00.000Z");

const mocks = vi.hoisted(() => ({
  findNativeAppAuthBySessionId: vi.fn(),
}));

vi.mock("@beutl/i18n", () => ({
  getTranslation: async () => ({ t: (key: string) => key }),
}));

vi.mock("@beutl/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@beutl/db")>();
  return {
    ...actual,
    createNativeAppAuth: vi.fn(),
    deleteNativeAppAuthBySessionId: vi.fn(),
    findNativeAppAuthById: vi.fn(),
    findNativeAppAuthBySessionId: mocks.findNativeAppAuthBySessionId,
    updateNativeAppAuthForHandler: vi.fn(),
  };
});

import {
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

describe("v1 refresh-token rotation", () => {
  let store: ReturnType<typeof createSessionPrisma>;

  async function issueCredentials(userId: string): Promise<Credentials> {
    mocks.findNativeAppAuthBySessionId.mockResolvedValueOnce({
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
    delete process.env.JWT_SECRET;
    delete process.env.JWT_ISSUER;
    delete process.env.JWT_AUDIENCE;
    delete process.env.JWT_EXPIRATION_MINUTES;
    delete process.env.JWT_REFRESH_TOKEN_EXPIRATION_DAYS;
  });

  it("assigns a family only to the initial native refresh session", async () => {
    await issueCredentials("session-owner");

    expect(store.all()).toHaveLength(1);
    expect(store.all()[0]).toMatchObject({
      userId: "session-owner",
      refreshTokenFamilyId: expect.any(String),
      refreshTokenConsumedAt: null,
      refreshTokenReplacedByToken: null,
      refreshTokenRevokedAt: null,
    });
  });

  it("adopts a pre-deployment native session on its first refresh", async () => {
    const credentials = await issueCredentials("legacy-session-owner");
    const legacySession = store.all()[0];
    store.update(legacySession.token, {
      refreshTokenFamilyId: null,
    });

    const response = await post("/refresh", {
      refresh_token: credentials.refresh_token,
      token: credentials.token,
    });

    expect(response.status).toBe(200);
    expect(store.all()).toHaveLength(2);
    const adoptedParent = store.get(legacySession.token);
    expect(adoptedParent).toMatchObject({
      userId: "legacy-session-owner",
      refreshTokenFamilyId: expect.any(String),
      refreshTokenConsumedAt: NOW,
      refreshTokenRevokedAt: null,
    });
    expect(
      store.get(adoptedParent!.refreshTokenReplacedByToken!),
    ).toMatchObject({
      userId: "legacy-session-owner",
      refreshTokenFamilyId: adoptedParent!.refreshTokenFamilyId,
      refreshTokenConsumedAt: null,
      refreshTokenRevokedAt: null,
    });
  });

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

    const response = await post("/refresh", {
      refresh_token: credentials.refresh_token,
      token: credentials.token,
    });

    expect(response.status).toBe(401);
    expect(store.all()).toHaveLength(1);
  });

  it("returns one child to concurrent legacy refresh callers", async () => {
    const credentials = await issueCredentials("session-owner");
    const legacySession = store.all()[0];
    store.update(legacySession.token, {
      refreshTokenFamilyId: null,
    });
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
    const before = store.get("better-auth-browser-token");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const response = await post("/refresh", {
        refresh_token: "better-auth-browser-token",
        token: "unused-browser-access-token",
      });

      expect(response.status).toBe(401);
      expect(store.get("better-auth-browser-token")).toEqual(before);
      expect(store.all()).toHaveLength(1);
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
    expect(store.all()).toHaveLength(2);
    expect(
      store.all().filter((session) => !session.refreshTokenConsumedAt),
    ).toHaveLength(1);
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
      store.all().every((session) => session.refreshTokenRevokedAt !== null),
    ).toBe(true);
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
