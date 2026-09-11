import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveMagicLinkLanguage,
  sendMagicLinkEmail,
} from "@beutl/next/magic-link-email";

const fetchMock = vi.fn();

function payload() {
  const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return JSON.parse(init.body as string) as {
    to: string;
    subject: string;
    html: string;
    text: string;
  };
}

describe("magic link email", () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("takes the language from the callbackURL prefix the sign-in page set", () => {
    const url =
      "https://beutl.beditor.net/api/auth/magic-link/verify?token=t&callbackURL=%2Fen%2Fstore";
    expect(resolveMagicLinkLanguage(url)).toBe("en");
    expect(
      resolveMagicLinkLanguage(
        "https://beutl.beditor.net/api/auth/magic-link/verify?token=t&callbackURL=https%3A%2F%2Fbeutl.beditor.net%2Fja%2Fdashboard",
      ),
    ).toBe("ja");
  });

  it("falls back to Accept-Language, then the default, without a language prefix", () => {
    const url =
      "https://beutl.beditor.net/api/auth/magic-link/verify?token=t&callbackURL=%2Fdashboard";
    expect(
      resolveMagicLinkLanguage(url, {
        headers: new Headers({ "accept-language": "en-US,en;q=0.9" }),
      }),
    ).toBe("en");
    expect(resolveMagicLinkLanguage(url)).toBe("ja");
  });

  it("sends the subject, body, button and footer in that language", async () => {
    await sendMagicLinkEmail({
      email: "user@example.com",
      url: "https://beutl.beditor.net/api/auth/magic-link/verify?token=t&callbackURL=%2Fen",
    });
    const en = payload();
    expect(en.to).toBe("user@example.com");
    expect(en.subject).toBe("Sign in to beutl.beditor.net");
    expect(en.html).toContain("<p>Click the button below to sign in.</p>");
    expect(en.html).toContain(">Sign in</a>");
    expect(en.html).toContain("https://beutl.beditor.net/en/docs/terms");
    expect(en.text).toContain(
      "Sign in: https://beutl.beditor.net/api/auth/magic-link/verify?token=t&callbackURL=%2Fen",
    );

    await sendMagicLinkEmail({
      email: "user@example.com",
      url: "https://beutl.beditor.net/api/auth/magic-link/verify?token=t&callbackURL=%2Fja",
    });
    const ja = payload();
    expect(ja.subject).toBe("beutl.beditor.net にサインイン");
    expect(ja.html).toContain(">サインイン</a>");
    expect(ja.html).toContain("https://beutl.beditor.net/ja/docs/terms");
  });
});
