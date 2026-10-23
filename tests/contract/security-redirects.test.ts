import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ cookie: vi.fn(), deleteCookie: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: mocks.cookie, delete: mocks.deleteCookie }),
  headers: async () => new Headers({ "x-url": "https://beutl.beditor.net/en/dashboard/account/security/handle" }),
}));
vi.mock("@beutl/next/language", () => ({ getLanguage: async () => "en" }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw new Error(`redirect:${url}`); },
}));

import { GET } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/account/security/handle/route";
import DocsPage from "../../apps/web/src/app/[lang]/(docs)/docs/[...slug]/page";

beforeEach(() => vi.resetAllMocks());

describe("account security callback", () => {
  it.each([
    "{broken", "", "null", "[]", "1", '"string"', "{}",
    '{"type":"adding-account","url":123}',
    '{"type":"adding-account","url":"/en/dashboard/account/security"}',
  ])("clears unusable or completed flow cookies without a 500 (%s)", async (value) => {
    mocks.cookie.mockReturnValue({ value });
    const response = await GET();
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://beutl.beditor.net/en/dashboard/account/security");
    expect(mocks.deleteCookie).toHaveBeenCalledWith("beutl.auth-flow");
  });

  it("redirects normally without a flow cookie", async () => {
    expect((await GET()).status).toBe(307);
    expect(mocks.deleteCookie).not.toHaveBeenCalled();
  });

  it("preserves a well-formed unrelated flow", async () => {
    mocks.cookie.mockReturnValue({ value: '{"type":"other-flow","url":"/en/account"}' });
    expect((await GET()).status).toBe(307);
    expect(mocks.deleteCookie).not.toHaveBeenCalled();
  });
});

describe("documentation redirects", () => {
  it.each([
    ["en", ["guide", "installation"], "/en/guide/installation"],
    ["ja", ["ガイド"], "/ja/%E3%82%AC%E3%82%A4%E3%83%89"],
    ["en", ["//evil.example", "?next=https://evil.example#fragment"], "/en/%2F%2Fevil.example/%3Fnext%3Dhttps%3A%2F%2Fevil.example%23fragment"],
    ["/\\evil.example", ["guide"], "/%2F%5Cevil.example/guide"],
  ])("keeps %s/%s on the documentation origin", async (lang, slug, path) => {
    await expect(DocsPage({ params: Promise.resolve({ lang, slug }) })).rejects.toThrow(
      `redirect:https://docs.beutl.beditor.net${path}`,
    );
  });
});
