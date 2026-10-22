import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDbProvider } from "@beutl/db";
import { getAuth as getWebAuth } from "../../apps/web/src/lib/better-auth";
import { getAuth as getAdminAuth } from "../../apps/admin/src/lib/better-auth";
import { betterAuth } from "../../apps/web/node_modules/better-auth";
import { memoryAdapter } from "../../apps/web/node_modules/better-auth/dist/adapters/memory-adapter/index.mjs";

vi.mock("@beutl/next/audit-log", () => ({
  addAuditLog: vi.fn(),
  auditLogActions: { authjs: {} },
}));
vi.mock("@beutl/next/magic-link-email", () => ({ sendMagicLinkEmail: vi.fn() }));

const ORIGIN = "http://localhost:3000";
const SECRET = "oauth-email-security-test-secret-at-least-32-characters";
const owner = {
  id: "owner", name: "Owner", email: "owner@example.com", emailVerified: true,
  createdAt: new Date(), updatedAt: new Date(),
};
const savedSession = {
  id: "existing-session", token: "existing-session-token", userId: owner.id,
  createdAt: new Date(), updatedAt: new Date(),
  expiresAt: new Date(Date.now() + 86_400_000),
};

let profile: { id: number; login: string; email: string | null };
let emails: { email: string; primary: boolean; verified: boolean }[];
let emailStatus: number;

beforeEach(() => {
  vi.stubEnv("BETTER_AUTH_URL", ORIGIN);
  vi.stubEnv("BETTER_AUTH_SECRET", SECRET);
  vi.stubEnv("BETTER_AUTH_COOKIE_DOMAIN", "");
  vi.stubEnv("AUTH_GITHUB_ID", "test-github-client");
  vi.stubEnv("AUTH_GITHUB_SECRET", "test-github-secret");
  vi.stubEnv("AUTH_GOOGLE_ID", "test-google-client");
  vi.stubEnv("AUTH_GOOGLE_SECRET", "test-google-secret");
  profile = { id: 1234, login: "github-owner", email: owner.email };
  emails = [{ email: owner.email, primary: true, verified: true }];
  emailStatus = 200;
  setDbProvider(async () => ({
    profile: { findFirst: async () => null, create: async () => ({}) },
  }) as never);
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "test-token", token_type: "bearer", scope: "read:user,user:email" });
    }
    if (url === "https://api.github.com/user") return Response.json(profile);
    if (url === "https://api.github.com/user/emails") {
      return Response.json(emailStatus === 200 ? emails : { message: "Forbidden" }, { status: emailStatus });
    }
    throw new Error(`Unexpected OAuth request: ${url}`);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function setup(getAuth = getWebAuth, linked = false, existingUser = true) {
  const db = {
    user: existingUser ? [{ ...owner }] : [],
    account: linked ? [{
      id: "github-account", providerId: "github", accountId: "1234", userId: owner.id,
      createdAt: new Date(), updatedAt: new Date(),
    }] : [],
    session: existingUser ? [{ ...savedSession }] : [],
    verification: [],
  };
  const configured = await getAuth();
  const auth = betterAuth({
    ...configured.options,
    database: memoryAdapter(db),
    logger: { disabled: true },
  });
  return { db, auth };
}

async function completeOAuth(auth: Awaited<ReturnType<typeof setup>>["auth"], link = false) {
  const signature = createHmac("sha256", SECRET).update(savedSession.token).digest("base64");
  const response = await auth.handler(new Request(`${ORIGIN}/api/auth/${link ? "link-social" : "sign-in/social"}`, {
    method: "POST",
    headers: {
      "content-type": "application/json", origin: ORIGIN,
      ...(link ? { cookie: `better-auth.session_token=${encodeURIComponent(`${savedSession.token}.${signature}`)}` } : {}),
    },
    body: JSON.stringify({ provider: "github", callbackURL: "/en/dashboard" }),
  }));
  expect(response.status).toBe(200);
  const authorization = new URL((await response.json()).url);
  const callback = new URL(`${ORIGIN}/api/auth/callback/github`);
  callback.searchParams.set("code", "test-code");
  callback.searchParams.set("state", authorization.searchParams.get("state")!);
  return auth.handler(new Request(callback, {
    headers: { cookie: response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ") },
  }));
}

describe.each([
  { name: "web", getAuth: getWebAuth },
  { name: "admin", getAuth: getAdminAuth },
])("$name GitHub OAuth", ({ getAuth }) => {
  it.each(["verified", "unverified", "email API unavailable"])(
    "signs in an existing provider identity after an email change: %s",
    async (verification) => {
      const { auth, db } = await setup(getAuth, true);
      profile.email = "changed@example.com";
      emails = [{ email: profile.email, primary: true, verified: verification === "verified" }];
      if (verification === "email API unavailable") emailStatus = 403;
      // An email match must not redirect an already-linked identity to another user.
      db.user.push({ ...owner, id: "other", email: profile.email });

      const response = await completeOAuth(auth);

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/en/dashboard");
      expect(db.session).toHaveLength(2);
      expect(db.session.every((session) => session.userId === owner.id)).toBe(true);
      expect(db.session.find((session) => session.id === savedSession.id)).toEqual(savedSession);
      expect(db.user.find((user) => user.id === owner.id)?.email).toBe(owner.email);
      expect(db.account).toHaveLength(1);
    },
  );

  it("refuses implicit linking through an unverified matching email", async () => {
    const { auth, db } = await setup(getAuth);
    emails[0].verified = false;

    const response = await completeOAuth(auth);

    expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe("account_not_linked");
    expect(db.account).toEqual([]);
    expect(db.session).toEqual([savedSession]);
  });

  it("links a new provider identity with a verified matching email", async () => {
    const { auth, db } = await setup(getAuth);

    const response = await completeOAuth(auth);

    expect(response.headers.get("location")).toBe("/en/dashboard");
    expect(db.account).toEqual([expect.objectContaining({ providerId: "github", accountId: "1234", userId: owner.id })]);
    expect(db.session).toHaveLength(2);
  });

  it("refuses an unverified explicit link without revoking the owner's session", async () => {
    const { auth, db } = await setup(getAuth);
    emails[0].verified = false;

    const response = await completeOAuth(auth, true);

    expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe("githubEmailNotVerified");
    expect(db.account).toEqual([]);
    expect(db.session).toEqual([expect.objectContaining({
      id: savedSession.id, token: savedSession.token, userId: owner.id,
    })]);
  });
});

describe("GitHub user provisioning", () => {
  it.each([false, true])("requires a verified email for a new user: verified=%s", async (verified) => {
    const { auth, db } = await setup(getWebAuth, false, false);
    emails[0].verified = verified;

    const response = await completeOAuth(auth);

    if (verified) {
      expect(response.headers.get("location")).toBe("/en/dashboard");
      expect(db.user).toEqual([expect.objectContaining({ email: owner.email, emailVerified: true })]);
      expect(db.account).toHaveLength(1);
      expect(db.session).toHaveLength(1);
    } else {
      expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe("githubEmailNotVerified");
      expect(db.user).toEqual([]);
      expect(db.account).toEqual([]);
      expect(db.session).toEqual([]);
    }
  });
});
