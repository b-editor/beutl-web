import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  database: { user: [] as Record<string, unknown>[], session: [] as Record<string, unknown>[] },
}));
vi.mock("@beutl/db", () => ({ getDb: async () => ({}) }));
vi.mock("@beutl/next/audit-log", () => ({ addAuditLog: vi.fn(), auditLogActions: { authjs: {} } }));
vi.mock("@beutl/next/auth-hooks", () => ({ onUserCreated: vi.fn() }));
vi.mock("@beutl/next/magic-link-email", () => ({ sendMagicLinkEmail: vi.fn() }));
vi.mock("../../apps/web/node_modules/better-auth/dist/adapters/prisma-adapter/index.mjs", async () => {
  const { memoryAdapter } = await import("../../apps/web/node_modules/better-auth/dist/adapters/memory-adapter/index.mjs");
  return { prismaAdapter: () => memoryAdapter(state.database) };
});


import { auth, getAuth } from "../../apps/web/src/lib/better-auth";
const secret = "server-component-session-test-secret-123456";
const token = "test-session-token";
function requestHeaders() {
  const signed = encodeURIComponent(`${token}.${createHmac("sha256", secret).update(token).digest("base64")}`);
  return new Headers({ cookie: `better-auth.session_token=${signed}` });
}

async function afterRender<T>(run: () => Promise<T>): Promise<T> {
  // Match the Next.js 15 request phase which produced E88 in the running app.
  (globalThis as unknown as { AsyncLocalStorage: typeof AsyncLocalStorage }).AsyncLocalStorage ??= AsyncLocalStorage;
  const require = createRequire(import.meta.url);
  const { workAsyncStorage } = require("../../apps/web/node_modules/next/dist/server/app-render/work-async-storage.external.js");
  const { workUnitAsyncStorage } = require("../../apps/web/node_modules/next/dist/server/app-render/work-unit-async-storage.external.js");
  return workAsyncStorage.run({ route: "/[lang]/dashboard/ai/video" }, () =>
    workUnitAsyncStorage.run({ type: "request", phase: "after" }, run));
}

describe("Server Component session reads", () => {
  beforeEach(() => {
    vi.stubEnv("BETTER_AUTH_SECRET", secret);
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
    vi.stubEnv("BETTER_AUTH_COOKIE_DOMAIN", "");
    state.database.user = [];
    state.database.session = [];

  });
  afterEach(() => vi.unstubAllEnvs());

  it("does not revisit request cookies when an expired session returns after render", async () => {
    await expect(afterRender(() => auth.api.getSession({ headers: requestHeaders() }))).resolves.toBeNull();
  });

  it("returns a valid session without extending its expiry during rendering", async () => {
    const createdAt = new Date(Date.now() - 2 * 86400000);
    const expiresAt = new Date(Date.now() + 3600000);
    state.database.user = [{ id: "owner", name: "Owner", email: "owner@example.test", emailVerified: true, createdAt, updatedAt: createdAt }];
    state.database.session = [{ id: "session", userId: "owner", token, expiresAt, createdAt, updatedAt: createdAt }];
    const result = await afterRender(() => auth.api.getSession({ headers: requestHeaders() }));
    expect(result?.user.id).toBe("owner");
    expect(result?.session.expiresAt).toEqual(expiresAt);
    expect(state.database.session[0]?.expiresAt).toEqual(expiresAt);
  });

  it("reproduces the failure with the cookie-writing auth instance", async () => {
    const instance = await getAuth();
    await expect(afterRender(() => instance.api.getSession({ headers: requestHeaders() })))
      .rejects.toThrow('used "cookies" inside "after(...)"');
  });

  it("keeps cookie writing available for actions", async () => {
    const response = await auth.handler(new Request("http://localhost:3000/api/auth/get-session", { headers: requestHeaders() }));
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("better-auth.session_token=");
  });
});
