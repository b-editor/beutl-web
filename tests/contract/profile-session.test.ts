import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDbProvider } from "@beutl/db";
import { auth, getAuth } from "../../apps/web/src/lib/better-auth";

vi.mock("@beutl/next/audit-log", () => ({ addAuditLog: vi.fn(), auditLogActions: {} }));
vi.mock("@beutl/next/magic-link-email", () => ({ sendMagicLinkEmail: vi.fn() }));

const SECRET = "profile-session-test-secret-at-least-32-characters";
const TOKEN = "profile-session-token";
const now = new Date();
const user = {
  id: "owner",
  name: "Google Account Name",
  email: "owner@example.com",
  image: "https://google.example/avatar.png",
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
};
const session = {
  id: "session-1",
  token: TOKEN,
  userId: user.id,
  createdAt: now,
  updatedAt: now,
  expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
};
const profile = {
  userId: user.id,
  displayName: "Profile Name",
  userName: "profile-owner",
  iconFileId: "profile-icon",
};
const db = {
  profile: { findFirst: vi.fn() },
  session: { findFirst: vi.fn() },
  user: { findFirst: vi.fn() },
};

function headers(extraCookies: string[] = []) {
  const signature = createHmac("sha256", SECRET).update(TOKEN).digest("base64");
  return new Headers({
    cookie: [
      `better-auth.session_token=${encodeURIComponent(`${TOKEN}.${signature}`)}`,
      ...extraCookies,
    ].join("; "),
  });
}

beforeEach(() => {
  vi.stubEnv("BETTER_AUTH_SECRET", SECRET);
  vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
  vi.stubEnv("BETTER_AUTH_COOKIE_DOMAIN", "");
  vi.stubEnv("AUTH_GOOGLE_ID", "test-google-id");
  vi.stubEnv("AUTH_GOOGLE_SECRET", "test-google-secret");
  vi.stubEnv("AUTH_GITHUB_ID", "test-github-id");
  vi.stubEnv("AUTH_GITHUB_SECRET", "test-github-secret");
  vi.clearAllMocks();
  db.profile.findFirst.mockResolvedValue({ ...profile });
  db.session.findFirst.mockResolvedValue({ ...session });
  db.user.findFirst.mockResolvedValue({ ...user });
  setDbProvider(async () => db as never);
});
afterEach(() => vi.unstubAllEnvs());

describe("profile identity in authenticated sessions", () => {
  it.each(["Google", "GitHub"])("uses the saved identity instead of the %s identity", async (provider) => {
    db.user.findFirst.mockResolvedValue({
      ...user,
      name: `${provider} Account Name`,
      image: `https://${provider.toLowerCase()}.example/avatar.png`,
    });
    const result = await auth.api.getSession({ headers: headers() });
    expect(result?.user).toMatchObject({
      id: user.id,
      email: user.email,
      name: profile.displayName,
      image: "/api/contents/profile-icon",
    });
    expect(result?.session.id).toBe(session.id);
    // Better Auth loads the real OAuth providers lazily on the first request.
  }, 30_000);

  it("returns the same profile identity through the browser session endpoint", async () => {
    const response = await auth.handler(new Request("http://localhost:3000/api/auth/get-session", {
      headers: headers(),
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).user).toMatchObject({
      name: profile.displayName,
      image: "/api/contents/profile-icon",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("reads updated profile information even when the auth user is cookie-cached", async () => {
    const instance = await getAuth();
    const first = await instance.api.getSession({ headers: headers(), returnHeaders: true });
    const cached = first.headers.getSetCookie()
      .filter((value) => value.startsWith("better-auth.session_data="))
      .map((value) => value.split(";")[0]);
    expect(cached).toHaveLength(1);
    db.profile.findFirst.mockResolvedValue({
      ...profile,
      displayName: "Updated Profile",
      iconFileId: "updated-icon",
    });
    db.session.findFirst.mockClear();
    db.user.findFirst.mockClear();

    const result = await instance.api.getSession({ headers: headers(cached) });
    expect(result?.user).toMatchObject({
      name: "Updated Profile",
      image: "/api/contents/updated-icon",
    });
    expect(db.session.findFirst).not.toHaveBeenCalled();
    expect(db.user.findFirst).not.toHaveBeenCalled();
  });

  it("uses the profile username and default icon when those settings are empty", async () => {
    db.profile.findFirst.mockResolvedValue({ ...profile, displayName: "", iconFileId: null });
    const result = await auth.api.getSession({ headers: headers() });
    expect(result?.user).toMatchObject({ name: profile.userName, image: null });
  });

  it("does not restore a provider name or icon for an account without a profile", async () => {
    db.profile.findFirst.mockResolvedValue(null);
    const result = await auth.api.getSession({ headers: headers() });
    expect(result?.user).toMatchObject({ id: user.id, name: "", image: null });
  });

  it("leaves signed-out sessions empty without querying a profile", async () => {
    expect(await auth.api.getSession({ headers: new Headers() })).toBeNull();
    expect(db.profile.findFirst).not.toHaveBeenCalled();
  });
});
