import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDbProvider } from "@beutl/db";
import {
  createSessionPrisma,
  type NativeAppAuthRecord,
} from "../stubs/session-prisma";
import {
  issueNativeAuthCodeForSession,
  nativeAuthDestinationHost,
} from "@beutl/next/native-auth-issuance";
import { issueNativeAuthCodeAction } from "../../apps/web/src/app/[lang]/(auth-flow)/account/native-auth/handler/actions";

const session = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/better-auth", () => ({ auth: { api: { getSession: session.getSession } } }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const validRow = (): NativeAppAuthRecord => ({
  id: "auth-id",
  sessionId: "native-session",
  userId: null,
  code: null,
  continueUrl: "http://localhost:43123/callback",
  codeExpires: null,
});

describe("issueNativeAuthCodeForSession", () => {
  let store: ReturnType<typeof createSessionPrisma>;
  beforeEach(() => {
    store = createSessionPrisma();
    setDbProvider(async () => store.prisma as never);
  });
  afterEach(() => {
    setDbProvider(void 0 as never);
    vi.restoreAllMocks();
  });

  it("issues a code bound to the consenting user and returns the callback", async () => {
    store.putNativeAppAuth(validRow());

    const result = await issueNativeAuthCodeForSession({
      identifier: "auth-id",
      userId: "consenter",
    });

    expect(result).toEqual({
      ok: true,
      callbackUrl: expect.stringMatching(/^http:\/\/localhost:43123\/callback\?code=/),
    });

    const [row] = store.allNativeAppAuth();
    expect(row.userId).toBe("consenter");
    expect(row.code).toEqual(expect.any(String));
    expect(row.code).toHaveLength(64); // randomString(32) = 64 hex chars
    expect(Number.isFinite(row.codeExpires?.getTime())).toBe(true);
    expect((row.codeExpires as Date).getTime()).toBeGreaterThan(Date.now());
    expect((row.codeExpires as Date).getTime()).toBeLessThanOrEqual(
      Date.now() + 30 * 60 * 1000 + 1000,
    );

    // 返した callbackUrl の code は永続化したものと同じ (デスクトップは
    // session_id + コードで引き換える)。
    expect(new URL(result.ok ? result.callbackUrl : "").searchParams.get("code")).toBe(row.code);
  });

  it("does not persist a code when the stored callback is unsafe (validate before persist)", async () => {
    store.putNativeAppAuth({ ...validRow(), continueUrl: "https://attacker.example/" });

    const result = await issueNativeAuthCodeForSession({
      identifier: "auth-id",
      userId: "consenter",
    });

    expect(result).toEqual({ ok: false, reason: "unsafeContinueUrl" });
    expect(store.allNativeAppAuth()).toHaveLength(1);
    expect(store.allNativeAppAuth()[0]).toMatchObject(
      { userId: null, code: null, codeExpires: null },
    );
  });

  it("reports a missing row for an unknown or consumed identifier", async () => {
    const result = await issueNativeAuthCodeForSession({
      identifier: "missing",
      userId: "consenter",
    });

    expect(result).toEqual({ ok: false, reason: "rowNotFound" });
    expect(store.allNativeAppAuth()).toEqual([]);
  });

  it("accepts https site callbacks as well as loopback ones", async () => {
    store.putNativeAppAuth({
      ...validRow(),
      continueUrl: "https://beutl.beditor.net/app/callback",
    });

    const result = await issueNativeAuthCodeForSession({
      identifier: "auth-id",
      userId: "consenter",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.callbackUrl.startsWith("https://beutl.beditor.net/app/callback?code=")).toBe(true);
    }
  });
});

describe("nativeAuthDestinationHost", () => {
  it.each([
    ["http://localhost:43123/callback", "localhost:43123"],
    ["https://beutl.beditor.net/app/callback", "beutl.beditor.net"],
  ])("shows the destination host for allowed callbacks: %s", (continueUrl, host) => {
    expect(nativeAuthDestinationHost(continueUrl)).toBe(host);
  });

  it.each([
    "https://attacker.example/callback",
    "javascript://localhost/callback",
    "http://beutl.beditor.net/callback",
    "not a url",
  ])("hides destinations that must not be consented to: %s", (continueUrl) => {
    expect(nativeAuthDestinationHost(continueUrl)).toBeNull();
  });
});

describe("native-auth consent action", () => {
  let store: ReturnType<typeof createSessionPrisma>;
  const consent = () => {
    const form = new FormData();
    form.set("identifier", "auth-id");
    form.set("userId", "consenter");
    return form;
  };

  beforeEach(() => {
    store = createSessionPrisma();
    store.putNativeAppAuth(validRow());
    setDbProvider(async () => store.prisma as never);
    session.getSession.mockReset().mockResolvedValue({ user: { id: "consenter" } });
  });

  afterEach(() => {
    setDbProvider(void 0 as never);
    vi.restoreAllMocks();
  });

  it("issues only for the account shown after consulting the session store", async () => {
    const result = await issueNativeAuthCodeAction({ status: "idle" }, consent());
    expect(result).toMatchObject({ status: "ok" });
    expect(session.getSession).toHaveBeenCalledWith({
      headers: expect.any(Headers), query: { disableCookieCache: true },
    });
    expect(store.allNativeAppAuth()[0]).toMatchObject({ userId: "consenter", code: expect.any(String) });
  });

  it.each([null, { user: { id: "different-account" } }])(
    "does not issue after the displayed session is revoked or switched: %s",
    async (current) => {
      session.getSession.mockResolvedValue(current);
      expect(await issueNativeAuthCodeAction({ status: "idle" }, consent())).toEqual({ status: "failed" });
      expect(store.allNativeAppAuth()[0]).toMatchObject({ userId: null, code: null, codeExpires: null });
    },
  );

  it.each(["identifier", "userId"])("rejects a missing %s before looking up the session", async (field) => {
    const form = consent();
    form.delete(field);
    expect(await issueNativeAuthCodeAction({ status: "idle" }, form)).toEqual({ status: "failed" });
    expect(session.getSession).not.toHaveBeenCalled();
    expect(store.allNativeAppAuth()[0].code).toBeNull();
  });

  it("rejects an unsafe destination even when submitting the action directly", async () => {
    store.putNativeAppAuth({ ...validRow(), continueUrl: "https://attacker.example/callback" });
    expect(await issueNativeAuthCodeAction({ status: "idle" }, consent())).toEqual({ status: "failed" });
    expect(store.allNativeAppAuth()[0]).toMatchObject({ userId: null, code: null });
  });

  it("reports a consumed request without issuing another code", async () => {
    vi.spyOn(store.prisma.nativeAppAuth, "update").mockRejectedValueOnce(new Error("Record disappeared"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await issueNativeAuthCodeAction({ status: "idle" }, consent())).toEqual({ status: "failed" });
    expect(store.allNativeAppAuth()[0].code).toBeNull();
  });
});
