import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  setDbProvider,
  listNativeDevices,
  revokeNativeDevice,
  cleanupExpiredAuthVerifications,
} from "@beutl/db";
import { createAuthWithPrisma } from "../../apps/web/src/lib/better-auth";
import { verifyNativeOAuthRequest } from "../../packages/api/src/api/oauth-auth";

vi.mock("@beutl/next/audit-log", () => ({
  addAuditLog: vi.fn(),
  auditLogActions: { authjs: { signIn: "signIn", signOut: "signOut", linkAccount: "linkAccount" } },
}));
const { Client } = createRequire(new URL("../../apps/web/package.json", import.meta.url))("pg");
const databaseUrl = process.env.TEST_DATABASE_URL;
const secret = "native-oauth-integration-only-secret-with-32-characters";
const hash = (text: string) => createHash("sha256").update(text).digest("base64url");
function deviceKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    privateKey,
    jwk,
    thumbprint: hash(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })),
  };
}
function proof(key: ReturnType<typeof deviceKey>, url: string, method: string, token?: string) {
  const uri = new URL(url);
  uri.search = "";
  uri.hash = "";
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const data = `${encode({ typ: "dpop+jwt", alg: "ES256", jwk: key.jwk })}.${encode({ jti: randomUUID(), iat: Math.floor(Date.now() / 1000), htm: method, htu: uri.href, ...(token ? { ath: hash(token) } : {}) })}`;
  return `${data}.${sign("sha256", Buffer.from(data), { key: key.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

(databaseUrl ? describe : describe.skip)("Better Auth native OAuth on CockroachDB", () => {
  const database = `native_oauth_${randomUUID().replaceAll("-", "")}`;
  let admin: InstanceType<typeof Client>, sql: InstanceType<typeof Client>, db: PrismaClient;
  let server: Server,
    auth: Awaited<ReturnType<typeof createAuthWithPrisma>>,
    origin: string,
    cookie: string;
  let sessionId: string;
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    url.pathname = "/defaultdb";
    admin = new Client({ connectionString: url.href });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    url.pathname = `/${database}`;
    sql = new Client({ connectionString: url.href });
    await sql.connect();
    await sql.query("SET create_table_with_schema_locked = off");
    const ddl = execFileSync(
      "vp",
      [
        "exec",
        "prisma",
        "migrate",
        "diff",
        "--from-empty",
        "--to-schema",
        "prisma/schema.prisma",
        "--script",
      ],
      {
        cwd: new URL("../../packages/db/", import.meta.url),
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const authTables = new Set([
      "User",
      "Account",
      "Session",
      "Verification",
      "Passkey",
      "Profile",
      "AuditLog",
    ]);
    for (let statement of ddl.split(";").filter((part) => part.trim())) {
      if (statement.includes('"Verification_expiresAt_idx"')) continue;
      statement = statement.replace(/\s*"passkeyVerifiedAt" TIMESTAMP\(3\),/, "");
      const table = statement.match(/(?:CREATE TABLE|ALTER TABLE| ON) "([^" ]+)"/)?.[1];
      const target = statement.match(/REFERENCES "([^" ]+)"/)?.[1];
      if (table && authTables.has(table) && (!target || authTables.has(target)))
        await sql.query(statement);
    }
    const migration = await readFile(
      new URL(
        "../../packages/db/prisma/migrations/20261024000000_native_oauth_provider/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    for (const table of ["User", "Session", "Verification"])
      await sql.query(`ALTER TABLE "${table}" SET (schema_locked = true)`);
    for (const statement of migration.split(";").filter((part) => part.trim()))
      await sql.query(statement);
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.href }) });
    setDbProvider(async () => db);
    server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const result = await auth.handler(
          new Request(`${origin}${request.url}`, {
            method: request.method,
            headers: request.headers as HeadersInit,
            ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
          }),
        );
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(Buffer.from(await result.arrayBuffer()));
      } catch {
        response.writeHead(500);
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    vi.stubEnv("BETTER_AUTH_URL", origin);
    vi.stubEnv("BETTER_AUTH_SECRET", secret);
    vi.stubEnv("BETTER_AUTH_COOKIE_DOMAIN", "");
    auth = await createAuthWithPrisma();
    await db.user.create({
      data: { id: "owner", email: "oauth-owner@example.test", name: "Owner", emailVerified: true },
    });
    const ctx = await auth.$context;
    const session = await ctx.internalAdapter.createSession("owner");
    sessionId = session.id;
    cookie = `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${createHmac("sha256", secret).update(session.token).digest("base64")}`)}`;
  }, 120_000);
  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await db?.$disconnect();
    await sql?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${database}" CASCADE`);
      await admin.end();
    }
    vi.unstubAllEnvs();
  });
  async function authorize(key = deviceKey(), changes: Record<string, string> = {}) {
    const verifier = randomUUID() + randomUUID();
    const params = new URLSearchParams({
      client_id: "beutl-desktop",
      response_type: "code",
      redirect_uri: "http://127.0.0.1:48512/__/auth/handler/",
      scope: "beutl:desktop offline_access",
      resource: `${origin}/api`,
      prompt: "consent",
      state: randomUUID(),
      code_challenge: hash(verifier),
      code_challenge_method: "S256",
      dpop_jkt: key.thumbprint,
      device_name: "Test laptop",
      ...changes,
    });
    const response = await auth.handler(
      new Request(`${origin}/api/auth/oauth2/authorize?${params}`, { headers: { cookie } }),
    );
    expect(response.status, await response.clone().text()).toBe(302);
    const location = new URL(response.headers.get("location")!, origin);
    expect(location.pathname).toBe("/account/native-auth/handler");
    return { key, verifier, query: location.search.slice(1), params };
  }
  async function consent(request: Awaited<ReturnType<typeof authorize>>, accept = true) {
    return auth.api.oauth2Consent({
      asResponse: false,
      request: new Request(`${origin}/api/auth/oauth2/consent`, { method: "POST" }),
      headers: new Headers({ cookie, origin }),
      body: { oauth_query: request.query, accept },
    });
  }
  async function exchange(
    request: Awaited<ReturnType<typeof authorize>>,
    code: string,
    overrides: Record<string, string> = {},
    key = request.key,
  ) {
    const url = `${origin}/api/auth/oauth2/token`;
    return auth.handler(
      new Request(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          DPoP: proof(key, url, "POST"),
        },
        body: new URLSearchParams({
          client_id: "beutl-desktop",
          grant_type: "authorization_code",
          code,
          code_verifier: request.verifier,
          redirect_uri: request.params.get("redirect_uri")!,
          ...overrides,
        }),
      }),
    );
  }
  async function registered() {
    const request = await authorize();
    const callback = new URL((await consent(request)).url);
    expect(callback.searchParams.get("state")).toBe(request.params.get("state"));
    expect(callback.searchParams.get("iss")).toBe(`${origin}/api/auth`);
    const response = await exchange(request, callback.searchParams.get("code")!);
    expect(response.status, await response.clone().text()).toBe(200);
    const tokens = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
    };
    expect(tokens.token_type).toBe("DPoP");
    return { ...request, tokens, code: callback.searchParams.get("code")! };
  }
  function resourceRequest(
    tokens: { access_token: string },
    key: ReturnType<typeof deviceKey>,
    url = `${origin}/api/v3/user`,
  ) {
    return new Request(url, {
      headers: {
        Authorization: `DPoP ${tokens.access_token}`,
        DPoP: proof(key, url, "GET", tokens.access_token),
      },
    });
  }
  it("authorizes without passkeys and binds access to the device key, method, URI and proof ID", async () => {
    const registration = await registered();
    const request = resourceRequest(registration.tokens, registration.key);
    await expect(verifyNativeOAuthRequest(request)).resolves.toBe("owner");
    await expect(verifyNativeOAuthRequest(request)).resolves.toBeNull();
    await expect(
      verifyNativeOAuthRequest(resourceRequest(registration.tokens, deviceKey())),
    ).resolves.toBeNull();
    const fresh = resourceRequest(registration.tokens, registration.key);
    await expect(
      verifyNativeOAuthRequest(new Request(fresh.url, { method: "POST", headers: fresh.headers })),
    ).resolves.toBeNull();
    await expect(
      verifyNativeOAuthRequest(new Request(`${origin}/api/v3/storage`, { headers: fresh.headers })),
    ).resolves.toBeNull();
    await expect(
      verifyNativeOAuthRequest(
        new Request(fresh.url, {
          headers: { Authorization: `Bearer ${registration.tokens.access_token}` },
        }),
      ),
    ).resolves.toBeNull();
    expect(await listNativeDevices("owner")).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Test laptop" })]),
    );
    expect((await exchange(registration, registration.code)).status).not.toBe(200);
    // Better Auth invalidates the original grant when a code is replayed.
    await expect(
      verifyNativeOAuthRequest(resourceRequest(registration.tokens, registration.key)),
    ).resolves.toBeNull();
  });
  it("rejects a wrong PKCE verifier and a token exchange using another device key", async () => {
    for (const mode of ["pkce", "key"]) {
      const request = await authorize();
      const code = new URL((await consent(request)).url).searchParams.get("code")!;
      const response = await exchange(
        request,
        code,
        mode === "pkce" ? { code_verifier: randomUUID() + randomUUID() } : {},
        mode === "key" ? deviceKey() : request.key,
      );
      expect(response.status).not.toBe(200);
    }
  });
  it("requires recent passkey confirmation only for an account with a passkey", async () => {
    const request = await authorize();
    const passkey = await db.passkey.create({
      data: {
        id: randomUUID(),
        userId: "owner",
        publicKey: "test",
        credentialID: randomUUID(),
        counter: 0,
        deviceType: "singleDevice",
        backedUp: false,
      },
    });
    try {
      await expect(consent(request)).rejects.toMatchObject({ status: "FORBIDDEN" });
      await db.session.update({
        where: { id: sessionId },
        data: { passkeyVerifiedAt: new Date() },
      });
      expect(new URL((await consent(request)).url).searchParams.has("code")).toBe(true);
    } finally {
      await db.passkey.delete({ where: { id: passkey.id } });
    }
  });
  it.each([false, true])("enforces native consent for POST parameters even with query parameters (%s)", async (withQuery) => {
    await registered();
    const request = await authorize();
    const passkey = await db.passkey.create({
      data: {
        userId: "owner",
        publicKey: "test",
        credentialID: randomUUID(),
        counter: 0,
        deviceType: "singleDevice",
        backedUp: false,
      },
    });
    await db.session.update({ where: { id: sessionId }, data: { passkeyVerifiedAt: null } });
    const post = (params: URLSearchParams) => auth.handler(new Request(
      `${origin}/api/auth/oauth2/authorize${withQuery ? `?${request.params}` : ""}`,
      {
        method: "POST",
        headers: { cookie, origin, "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
      },
    ));
    try {
      const withoutConsent = new URLSearchParams(request.params);
      withoutConsent.delete("prompt");
      const rejected = await post(withoutConsent);
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ error: "invalid_request" });

      const response = await post(request.params);
      expect(response.status, await response.clone().text()).toBe(302);
      const location = new URL(response.headers.get("location")!, origin);
      expect(location.pathname).toBe("/account/native-auth/handler");
      const posted = { ...request, query: location.search.slice(1) };
      await expect(consent(posted)).rejects.toMatchObject({ status: "FORBIDDEN" });
      await db.session.update({ where: { id: sessionId }, data: { passkeyVerifiedAt: new Date() } });
      expect(new URL((await consent(posted)).url).searchParams.has("code")).toBe(true);
    } finally {
      await db.passkey.delete({ where: { id: passkey.id } });
    }
  });
  it("rotates refresh tokens and disconnects only the selected device", async () => {
    const registration = await registered();
    const otherDevice = await registered();
    const url = `${origin}/api/auth/oauth2/token`;
    const refresh = (tokens = registration.tokens, key = registration.key) =>
      auth.handler(
        new Request(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            DPoP: proof(key, url, "POST"),
          },
          body: new URLSearchParams({
            client_id: "beutl-desktop",
            grant_type: "refresh_token",
            refresh_token: tokens.refresh_token,
          }),
        }),
      );
    const response = await refresh();
    expect(response.status, await response.clone().text()).toBe(200);
    const refreshed = await response.json();
    expect(refreshed.refresh_token).not.toBe(registration.tokens.refresh_token);
    await expect(
      verifyNativeOAuthRequest(resourceRequest(refreshed, registration.key)),
    ).resolves.toBe("owner");
    const device = await db.nativeDevice.findUniqueOrThrow({
      where: {
        userId_clientId_keyThumbprint: {
          userId: "owner",
          clientId: "beutl-desktop",
          keyThumbprint: registration.key.thumbprint,
        },
      },
    });
    expect(await revokeNativeDevice("another-user", device.id)).toBe(false);
    expect(await revokeNativeDevice("owner", device.id)).toBe(true);
    for (const tokens of [registration.tokens, refreshed])
      await expect(
        verifyNativeOAuthRequest(resourceRequest(tokens, registration.key)),
      ).resolves.toBeNull();
    for (const tokens of [registration.tokens, refreshed]) {
      const rejected = await refresh(tokens);
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ error: "invalid_grant" });
    }
    await expect(
      verifyNativeOAuthRequest(resourceRequest(otherDevice.tokens, otherDevice.key)),
    ).resolves.toBe("owner");
    const otherRefresh = await refresh(otherDevice.tokens, otherDevice.key);
    expect(otherRefresh.status, await otherRefresh.clone().text()).toBe(200);
    await expect(
      verifyNativeOAuthRequest(resourceRequest(await otherRefresh.json(), otherDevice.key)),
    ).resolves.toBe("owner");
  });
  it("rejects a modified consent query and returns a denial without a code", async () => {
    const request = await authorize();
    await expect(
      consent({ ...request, query: request.query.replace("Test+laptop", "Another") }),
    ).rejects.toBeDefined();
    const callback = new URL((await consent(request, false)).url);
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.has("code")).toBe(false);
  });
  it("cleans expired verification state without removing live replay reservations", async () => {
    const now = new Date();
    await db.verification.createMany({
      data: [
        {
          id: "expired-proof",
          identifier: "expired-proof",
          value: "1",
          expiresAt: new Date(now.getTime() - 60_000),
        },
        {
          id: "live-proof",
          identifier: "live-proof",
          value: "1",
          expiresAt: new Date(now.getTime() + 60_000),
        },
      ],
    });
    await cleanupExpiredAuthVerifications(now);
    expect(await db.verification.findUnique({ where: { id: "expired-proof" } })).toBeNull();
    expect(await db.verification.findUnique({ where: { id: "live-proof" } })).not.toBeNull();
  });
});
