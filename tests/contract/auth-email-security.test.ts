import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { revokeAllUserSessions, setDbProvider } from "@beutl/db";
import { auth, getAuth } from "../../apps/web/src/lib/better-auth";
import { getAuth as getAdminAuth } from "../../apps/admin/src/lib/better-auth";
import {
  approveEmailChange,
  sendConfirmationEmail,
  updateEmail,
} from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/account/email/actions";
import { signUpWithEmailAction } from "../../apps/web/src/app/[lang]/(auth-flow)/account/sign-up/actions";
import { signInWithEmailAction } from "../../apps/web/src/app/[lang]/(auth-flow)/account/sign-in/actions";
import { signInWithEmailAction as adminSignIn } from "../../apps/admin/src/app/[lang]/account/sign-in/actions";

const external = vi.hoisted(() => ({
  headers: new Headers(),
  magicEmail: vi.fn(),
  confirmationEmail: vi.fn(),
  stripe: vi.fn(),
}));
vi.mock("next/headers", () => ({ headers: async () => external.headers }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
  RedirectType: { replace: "replace" },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@beutl/next/language", () => ({ getLanguage: async () => "en" }));
vi.mock("@beutl/next/audit-log", () => ({
  addAuditLog: vi.fn(),
  auditLogActions: { account: {}, authjs: {} },
}));
vi.mock("@beutl/next/magic-link-email", () => ({ sendMagicLinkEmail: external.magicEmail }));
vi.mock("@beutl/email", () => ({
  emailButton: (url: string) => url,
  sendEmail: external.confirmationEmail,
}));
vi.mock("@/lib/customer", () => ({ updateCustomerEmailIfExist: external.stripe }));

const SECRET = "auth-email-security-test-secret-at-least-32-characters";
type Row = Record<string, any>;
let user: Row;
let sessions: Map<string, Row>;
let tokens: Map<string, Row>;
let counters: Map<string, Row>;
let transactions: Promise<unknown>;
const db = {
  profile: { findFirst: vi.fn() },
  user: { findFirst: vi.fn(), update: vi.fn() },
  session: { findFirst: vi.fn(), deleteMany: vi.fn() },
  refreshTokenFamily: { updateMany: vi.fn() },
  verification: { create: vi.fn() },
  confirmationToken: { create: vi.fn(), findUnique: vi.fn(), deleteMany: vi.fn() },
  authEmailRateLimit: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn(),
  },
  $transaction: vi.fn(),
};

function headers(cached: string[] = [], sessionId = "session-1") {
  const token = sessions.get(sessionId)?.token ?? "session-token-1";
  const signature = createHmac("sha256", SECRET).update(token).digest("base64");
  return new Headers({
    cookie: [
      `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
      ...cached,
    ].join("; "),
    origin: "http://localhost:3000",
    "sec-fetch-site": "same-origin",
    "cf-connecting-ip": "203.0.113.5",
    "x-url": "http://localhost:3000/en/dashboard/account/email",
  });
}
function equals(actual: unknown, expected: any) {
  return (
    actual === (typeof expected === "object" && expected !== null ? expected.equals : expected)
  );
}
function form(email: string) {
  const data = new FormData();
  data.set("email", email);
  return data;
}
function changeForm() {
  const data = new FormData();
  data.set("newEmail", "new@example.com");
  return data;
}
function emailLink(index: number) {
  return new URL(/http[^\s]+/.exec(external.confirmationEmail.mock.calls[index][0].body)![0]);
}
async function approve(link: URL) {
  return approveEmailChange(link.searchParams.get("token")!, link.searchParams.get("identifier")!);
}
async function confirm(link: URL) {
  return updateEmail(link.searchParams.get("token")!, link.searchParams.get("identifier")!);
}
const failed = "redirect:/en/dashboard/account/email?status=emailUpdateFailed";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.stubEnv("BETTER_AUTH_SECRET", SECRET);
  vi.stubEnv("AUTH_SECRET", "auth-email-confirmation-test-secret");
  vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
  vi.stubEnv("BETTER_AUTH_COOKIE_DOMAIN", "");
  vi.stubEnv("AUTH_GOOGLE_ID", "test-google-id");
  vi.stubEnv("AUTH_GOOGLE_SECRET", "test-google-secret");
  vi.stubEnv("AUTH_GITHUB_ID", "test-github-id");
  vi.stubEnv("AUTH_GITHUB_SECRET", "test-github-secret");
  const now = new Date();
  user = {
    id: "owner",
    name: "Owner",
    email: "owner@example.com",
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  };
  sessions = new Map([
    [
      "session-1",
      {
        id: "session-1",
        token: "session-token-1",
        userId: "owner",
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + 30 * 86400000),
      },
    ],
  ]);
  tokens = new Map();
  counters = new Map();
  transactions = Promise.resolve();
  db.profile.findFirst.mockResolvedValue({
    userId: "owner",
    userName: "owner",
    displayName: "Owner",
    iconFileId: null,
  });
  db.user.findFirst.mockImplementation(async ({ where }) =>
    where.email && !equals(user.email, where.email) ? null : { ...user },
  );
  db.user.update.mockImplementation(async ({ where, data }) => {
    if (where.email && where.email !== user.email) throw new Error("Email changed concurrently");
    Object.assign(user, data);
    return { ...user };
  });
  db.session.findFirst.mockImplementation(async ({ where }) => {
    const row = [...sessions.values()].find(
      (s) =>
        (!where.id || equals(s.id, where.id)) &&
        (!where.token || equals(s.token, where.token)) &&
        (!where.userId || equals(s.userId, where.userId)) &&
        (!where.expiresAt || s.expiresAt > where.expiresAt.gt) &&
        (!where.user?.email || equals(user.email, where.user.email)),
    );
    return row ? { ...row } : null;
  });
  db.session.deleteMany.mockImplementation(async ({ where }) => {
    let count = 0;
    for (const [id, session] of sessions)
      if (!where.userId || session.userId === where.userId) {
        sessions.delete(id);
        count++;
        for (const [key, token] of tokens) if (token.sessionId === id) tokens.delete(key);
      }
    return { count };
  });
  db.refreshTokenFamily.updateMany.mockResolvedValue({ count: 0 });
  db.verification.create.mockImplementation(async ({ data }) => ({
    id: crypto.randomUUID(),
    ...data,
  }));
  db.confirmationToken.create.mockImplementation(async ({ data }) => {
    tokens.set(`${data.identifier}:${data.token}`, { ...data });
    return { ...data };
  });
  db.confirmationToken.findUnique.mockImplementation(async ({ where }) => {
    const token = tokens.get(
      `${where.identifier_token.identifier}:${where.identifier_token.token}`,
    );
    if (!token) return null;
    const source = sessions.get(token.sessionId);
    return { ...token, session: source ? { ...source } : null, user: { email: user.email } };
  });
  db.confirmationToken.deleteMany.mockImplementation(async ({ where }) => {
    const key = `${where.identifier}:${where.token}`;
    const token = tokens.get(key);
    const source = token && sessions.get(token.sessionId);
    if (
      !token ||
      token.purpose !== where.purpose ||
      token.userId !== where.userId ||
      token.expires <= where.expires.gt ||
      (where.sessionId &&
        (token.sessionId !== where.sessionId ||
          token.sourceEmail !== where.sourceEmail ||
          !source ||
          source.expiresAt <= where.expires.gt ||
          user.email !== where.sourceEmail))
    )
      return { count: 0 };
    tokens.delete(key);
    return { count: 1 };
  });
  db.authEmailRateLimit.findUnique.mockImplementation(async ({ where }) =>
    counters.has(where.key) ? { ...counters.get(where.key) } : null,
  );
  db.authEmailRateLimit.findMany.mockImplementation(async ({ where, take }) =>
    [...counters.values()].filter((r) => r.expiresAt <= where.expiresAt.lte).slice(0, take),
  );
  db.authEmailRateLimit.upsert.mockImplementation(async ({ where, create, update }) => {
    const row = counters.has(where.key) ? { ...counters.get(where.key), ...update } : { ...create };
    counters.set(where.key, row);
    return row;
  });
  db.authEmailRateLimit.update.mockImplementation(async ({ where, data }) => {
    const row = counters.get(where.key)!;
    row.count += data.count.increment;
    return row;
  });
  db.authEmailRateLimit.deleteMany.mockImplementation(async ({ where }) => {
    for (const key of where.key.in)
      if (counters.get(key)?.expiresAt <= where.expiresAt.lte) counters.delete(key);
    return { count: 0 };
  });
  db.$transaction.mockImplementation((callback) => {
    const work = transactions.then(() => callback(db));
    transactions = work.catch(() => undefined);
    return work;
  });
  external.stripe.mockResolvedValue({ status: "updated" });
  setDbProvider(async () => db as never);
  external.headers = headers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("email-change authorization", () => {
  it("rejects the audited revoked-cookie-cache attack before issuing a link", async () => {
    const instance = await getAuth();
    const first = await instance.api.getSession({ headers: external.headers, returnHeaders: true });
    const cached = first.headers
      .getSetCookie()
      .filter((c) => c.startsWith("better-auth.session_data="))
      .map((c) => c.split(";")[0]);
    expect(cached).toHaveLength(1);
    await revokeAllUserSessions({ userId: "owner" });
    external.headers = headers(cached);
    expect((await auth.api.getSession({ headers: external.headers }))?.user.id).toBe("owner");
    expect(await sendConfirmationEmail({}, changeForm())).toMatchObject({ success: false });
    expect(tokens.size).toBe(0);
    expect(external.confirmationEmail).not.toHaveBeenCalled();
  });

  it("requires the current mailbox before contacting the new mailbox, then completes once", async () => {
    expect(await sendConfirmationEmail({}, changeForm())).toMatchObject({ success: true });
    expect(external.confirmationEmail.mock.calls[0][0].to).toBe("owner@example.com");
    expect(external.confirmationEmail.mock.calls[0][0].body).toContain("new@example.com");
    const first = emailLink(0);
    expect(first.searchParams.get("approval")).toBe("1");
    await expect(confirm(first)).rejects.toThrow(failed);
    expect(user.email).toBe("owner@example.com");
    expect(tokens.size).toBe(1);
    await expect(approve(first)).rejects.toThrow("status=emailVerificationSent");
    expect(external.confirmationEmail.mock.calls[1][0].to).toBe("new@example.com");
    const second = emailLink(1);
    expect(second.searchParams.has("approval")).toBe(false);
    await expect(confirm(second)).rejects.toThrow("status=emailUpdated");
    expect(user.email).toBe("new@example.com");
    expect(user.emailVerified).toBe(true);
    expect(external.stripe).toHaveBeenCalledOnce();
    await expect(confirm(second)).rejects.toThrow(failed);
    expect(external.stripe).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "invalidates pending links on session revocation (approved=%s)",
    async (approved) => {
      await sendConfirmationEmail({}, changeForm());
      if (approved)
        await expect(approve(emailLink(0))).rejects.toThrow("status=emailVerificationSent");
      const link = emailLink(approved ? 1 : 0);
      await revokeAllUserSessions({ userId: "owner" });
      expect(tokens.size).toBe(0);
      // A later legitimate login must not revive the old link.
      sessions.set("session-1", {
        id: "session-1",
        token: "session-token-1",
        userId: "owner",
        createdAt: new Date(),
        updatedAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
      });
      await expect(approved ? confirm(link) : approve(link)).rejects.toThrow(failed);
      expect(user.email).toBe("owner@example.com");
      expect(external.stripe).not.toHaveBeenCalled();
    },
  );

  it("refuses confirmation without a session even after the cookie-cache window", async () => {
    await sendConfirmationEmail({}, changeForm());
    await expect(approve(emailLink(0))).rejects.toThrow("status=emailVerificationSent");
    const link = emailLink(1);
    external.headers = new Headers();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 6 * 60000));
    await expect(confirm(link)).rejects.toThrow(failed);
    expect(user.email).toBe("owner@example.com");
    expect(external.stripe).not.toHaveBeenCalled();
  });

  it("refuses a link when its original mailbox has changed", async () => {
    await sendConfirmationEmail({}, changeForm());
    await expect(approve(emailLink(0))).rejects.toThrow("status=emailVerificationSent");
    user.email = "other-current@example.com";
    await expect(confirm(emailLink(1))).rejects.toThrow(failed);
    expect(user.email).toBe("other-current@example.com");
    expect(external.stripe).not.toHaveBeenCalled();
  });

  it("does not trust the request URL when constructing approval links", async () => {
    external.headers.set("x-url", "https://attacker.example/email");
    await sendConfirmationEmail({}, changeForm());
    expect(emailLink(0).origin).toBe("http://localhost:3000");
  });
});

describe("shared authentication-email limits", () => {
  it("blocks the sixth signup Server Action before token creation or email delivery", async () => {
    for (let i = 0; i < 5; i++)
      await expect(signUpWithEmailAction({}, form("recipient@example.com"))).rejects.toThrow(
        "account/verify-request",
      );
    expect(await signUpWithEmailAction({}, form("recipient@example.com"))).toHaveProperty(
      "message",
    );
    expect(external.magicEmail).toHaveBeenCalledTimes(5);
    expect(db.verification.create).toHaveBeenCalledTimes(5);
  });

  it("shares recipient quotas across Web, Admin, HTTP and direct server API calls", async () => {
    const instance = await getAuth();
    const admin = await getAdminAuth();
    for (let i = 0; i < 5; i++) {
      const current = i % 2 ? admin : instance;
      await current.api.signInMagicLink({
        headers: external.headers,
        body: { email: "recipient@example.com", callbackURL: "/en/dashboard" },
      });
    }
    external.headers.set("cf-connecting-ip", "203.0.113.99");
    const requestHeaders = new Headers(external.headers);
    requestHeaders.set("content-type", "application/json");
    const response = await instance.handler(
      new Request("http://localhost:3000/api/auth/sign-in/magic-link", {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({ email: "RECIPIENT@EXAMPLE.COM", callbackURL: "/en/dashboard" }),
      }),
    );
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(external.magicEmail).toHaveBeenCalledTimes(5);
  });

  it.each([
    ["Web", signInWithEmailAction],
    ["Admin", adminSignIn],
  ] as const)("returns a usable error for %s sign-in", async (_, action) => {
    for (let i = 0; i < 5; i++)
      await expect(action({}, form("owner@example.com"))).rejects.toThrow("account/verify-request");
    await expect(action({}, form("owner@example.com"))).resolves.toMatchObject({
      message: "Too many email requests. Please wait before trying again.",
    });
    expect(external.magicEmail).toHaveBeenCalledTimes(5);
  });

  it("keeps the hourly recipient cap when minute windows expire", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let minute = 0; minute < 4; minute++) {
      for (let i = 0; i < 5; i++)
        await expect(signUpWithEmailAction({}, form("recipient@example.com"))).rejects.toThrow(
          "account/verify-request",
        );
      vi.setSystemTime(new Date(Date.now() + 61_000));
    }
    expect(await signUpWithEmailAction({}, form("recipient@example.com"))).toHaveProperty(
      "message",
    );
    expect(external.magicEmail).toHaveBeenCalledTimes(20);
    vi.setSystemTime(new Date(Date.now() + 3600000));
    await expect(signUpWithEmailAction({}, form("recipient@example.com"))).rejects.toThrow(
      "account/verify-request",
    );
  });

  it("ignores spoofed forwarding headers while bounding different recipients by client IP", async () => {
    for (let i = 0; i < 20; i++) {
      external.headers.set("x-forwarded-for", `198.51.100.${i + 1}`);
      await expect(signUpWithEmailAction({}, form(`recipient${i}@example.com`))).rejects.toThrow(
        "account/verify-request",
      );
    }
    expect(await signUpWithEmailAction({}, form("one-more@example.com"))).toHaveProperty("message");
    expect(external.magicEmail).toHaveBeenCalledTimes(20);
  });

  it("normalizes IPv6 representations and addresses within the same /64", async () => {
    for (let i = 0; i < 5; i++) {
      external.headers.set(
        "cf-connecting-ip",
        i % 2 ? "2001:0db8:0000:0001:0:0:0:1" : "2001:db8:0:1::2",
      );
      await expect(signUpWithEmailAction({}, form("recipient@example.com"))).rejects.toThrow(
        "account/verify-request",
      );
    }
    expect(new Set([...counters.keys()].filter((key) => key.startsWith("ip-minute:"))).size).toBe(
      1,
    );
  });

  it("does not send mail when the shared limiter storage fails", async () => {
    db.authEmailRateLimit.findUnique.mockRejectedValue(new Error("rate-limit store unavailable"));
    await expect(signUpWithEmailAction({}, form("recipient@example.com"))).rejects.toThrow(
      "rate-limit store unavailable",
    );
    expect(external.magicEmail).not.toHaveBeenCalled();
    expect(db.verification.create).not.toHaveBeenCalled();
  });
});
