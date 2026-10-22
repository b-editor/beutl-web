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

// handler ページの同意 Server Action から呼ばれる発行モジュールの契約。
// 旧 handler ページは GET 描画時にここに相当するコードを走らせていたため、
// 「GET でも発行されてしまう」drive-by code issuance が成立していた。
// 発行はこの関数 (同意 POST) のみが行うこと、そしてコードの永続化前で
// 遷移先検証が済んでいること (旧実装は書き込み後に検証しており、unsafe URL
// の行にコードと userId が残っていた) をここで固定する。

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
    expect(row.codeExpires).toEqual(
      expect.anything(),
    );
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
