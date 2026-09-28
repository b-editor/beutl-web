import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sign } from "hono/jwt";
import { setDbProvider } from "@beutl/db";
import { createSessionPrisma, type NativeAppAuthRecord } from "../stubs/session-prisma";

vi.mock("@beutl/i18n", () => ({ getTranslation: async () => ({ t: (key: string) => key }) }));
import account from "../../packages/api/src/v1/account";

const authorization = (): NativeAppAuthRecord => ({
  id: "auth-id", sessionId: "native-session", userId: "owner", code: "one-use-code",
  continueUrl: "http://localhost:43123/callback", codeExpires: new Date(Date.now() + 60_000),
});
const post = (path: string, body: unknown) => account.request(path, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const exchange = () => post("/code2jwt", { session_id: "native-session", code: "one-use-code" });

describe("native authorization security", () => {
  let store: ReturnType<typeof createSessionPrisma>;
  beforeEach(() => {
    store = createSessionPrisma();
    setDbProvider(async () => store.prisma as never);
    vi.stubEnv("JWT_SECRET", "local-test-secret");
    vi.stubEnv("JWT_ISSUER", "");
    vi.stubEnv("JWT_AUDIENCE", "");
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it.each(["javascript://localhost/%0Aalert(1)//", "file://localhost/callback", "https://attacker.example/", "http://beutl.beditor.net/callback"])(
    "rejects an unsafe callback before persisting an authorization: %s", async (continue_uri) => {
      expect((await post("/createAuthUri", { continue_uri })).status).toBe(400);
      expect(store.allNativeAppAuth()).toEqual([]);
    },
  );
  it("accepts the desktop loopback callback", async () => {
    expect((await post("/createAuthUri", { continue_uri: authorization().continueUrl })).status).toBe(200);
    expect(store.allNativeAppAuth()).toHaveLength(1);
  });
  it.each(["javascript://localhost/%0Aalert(1)//", "http://beutl.beditor.net/callback"])("also refuses unsafe stored callbacks at the legacy handler: %s", async (continueUrl) => {
    store.putNativeAppAuth({ ...authorization(), continueUrl });
    const token = await sign({
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier": "owner",
      exp: Math.floor(Date.now() / 1000) + 60,
    }, "local-test-secret");
    expect((await account.request("/handler?identifier=auth-id", {
      headers: { authorization: `Bearer ${token}` },
    })).status).toBe(400);
  });
  it("allows only one concurrent exchange and one refresh-token family", async () => {
    store.putNativeAppAuth(authorization());
    const responses = await Promise.all([exchange(), exchange()]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
    expect(store.allFamilies()).toHaveLength(1);
    expect(store.all()).toHaveLength(1);
    expect(store.allNativeAppAuth()).toHaveLength(0);
    expect((await exchange()).status).toBe(401);
  });
  it("rolls back code consumption if refresh-token creation fails", async () => {
    store.putNativeAppAuth(authorization());
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(store.prisma.nativeRefreshToken, "create").mockRejectedValueOnce(new Error("database write failed"));
    expect((await exchange()).status).toBe(500);
    expect(store.allNativeAppAuth()).toHaveLength(1);
    expect(store.allFamilies()).toHaveLength(0);
    expect((await exchange()).status).toBe(200);
  });
  it.each(["expired", "rebound", "changed-code"])(
    "does not consume an authorization changed after its initial read: %s", async (change) => {
      store.putNativeAppAuth(authorization());
      const find = store.prisma.nativeAppAuth.findFirst;
      vi.spyOn(store.prisma.nativeAppAuth, "findFirst").mockImplementationOnce(async (query) => {
        const snapshot = await find(query);
        store.putNativeAppAuth({
          ...authorization(),
          ...(change === "expired" ? { codeExpires: new Date(0) } : {}),
          ...(change === "rebound" ? { userId: "other-owner" } : {}),
          ...(change === "changed-code" ? { code: "new-code" } : {}),
        });
        return snapshot;
      });
      expect((await exchange()).status).toBe(401);
      expect(store.allFamilies()).toHaveLength(0);
      expect(store.allNativeAppAuth()).toHaveLength(1);
    },
  );
});
