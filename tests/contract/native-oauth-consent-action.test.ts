import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readQuery: vi.fn(),
  getSession: vi.fn(),
  consent: vi.fn(),
}));

vi.mock("@/lib/native-oauth", () => ({ readNativeOAuthQuery: mocks.readQuery }));
vi.mock("@/lib/better-auth", () => ({
  getAuth: async () => ({
    $context: Promise.resolve({ secret: "test-secret" }),
    api: { getSession: mocks.getSession, oauth2Consent: mocks.consent },
  }),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

import { consentToNativeOAuth } from "../../apps/web/src/app/[lang]/(auth-flow)/account/native-auth/handler/oauth-actions";

const callback = "http://127.0.0.1:43123/__/auth/handler/";

describe("native OAuth consent navigation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.readQuery.mockResolvedValue({ name: "Test device" });
    mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
  });

  it.each([
    { accept: true, query: "code=authorization-code&state=test-state" },
    { accept: false, query: "error=access_denied&state=test-state" },
  ])("lets Next.js redirect after consent (accept=$accept)", async ({ accept, query }) => {
    const url = `${callback}?${query}`;
    mocks.consent.mockResolvedValue({ url });

    await expect(consentToNativeOAuth("signed-query", "user-1", accept)).rejects.toMatchObject({
      message: "NEXT_REDIRECT",
      digest: expect.stringContaining(url),
    });
    expect(mocks.consent).toHaveBeenCalledWith(expect.objectContaining({
      asResponse: false,
      request: expect.any(Request),
      body: { accept, oauth_query: "signed-query" },
    }));
  });

  it("rejects an invalid authorization query without issuing consent", async () => {
    mocks.readQuery.mockResolvedValue(null);
    await expect(consentToNativeOAuth("invalid-query", "user-1", true)).resolves.toEqual({ success: false });
    expect(mocks.consent).not.toHaveBeenCalled();
  });

  it.each([null, { user: { id: "another-user" } }])("rejects an absent or changed session: %j", async (session) => {
    mocks.getSession.mockResolvedValue(session);
    await expect(consentToNativeOAuth("signed-query", "user-1", true)).resolves.toEqual({ success: false });
    expect(mocks.consent).not.toHaveBeenCalled();
  });

  it("returns an inline failure when the provider rejects consent", async () => {
    mocks.consent.mockRejectedValue(new Error("Consent rejected"));
    await expect(consentToNativeOAuth("signed-query", "user-1", true)).resolves.toEqual({ success: false });
  });
});
