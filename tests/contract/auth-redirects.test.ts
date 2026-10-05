import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lang: "ja",
  getSession: vi.fn(),
  signInMagicLink: vi.fn(),
  existsUserByEmail: vi.fn(),
}));

vi.mock("@/lib/better-auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
  getAuth: async () => ({ api: { signInMagicLink: mocks.signInMagicLink } }),
}));
vi.mock("@beutl/db", () => ({ existsUserByEmail: mocks.existsUserByEmail }));
vi.mock("@beutl/next/language", () => ({ getLanguage: async () => mocks.lang }));
vi.mock("@beutl/i18n", async () => {
  const { z } = await import("../../apps/web/node_modules/zod");
  return { getTranslation: async () => ({ z, t: (key: string) => key }) };
});
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-url": `https://beutl.beditor.net/${mocks.lang}/account` }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));
vi.mock("../../apps/web/src/app/[lang]/(auth-flow)/account/sign-in/form", () => ({
  default: () => null,
}));
vi.mock("../../apps/web/src/app/[lang]/(auth-flow)/account/sign-up/form", () => ({
  default: () => null,
}));

import AccountPage from "../../apps/web/src/app/[lang]/(auth-flow)/account/page";
import SignInPage from "../../apps/web/src/app/[lang]/(auth-flow)/account/sign-in/page";
import SignUpPage from "../../apps/web/src/app/[lang]/(auth-flow)/account/sign-up/page";
import { signInWithEmailAction } from "../../apps/web/src/app/[lang]/(auth-flow)/account/sign-in/actions";
import { signUpWithEmailAction } from "../../apps/web/src/app/[lang]/(auth-flow)/account/sign-up/actions";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
  mocks.signInMagicLink.mockResolvedValue({ status: true });
  mocks.existsUserByEmail.mockResolvedValue(true);
});

describe.each(["ja", "en"])("authentication redirects (%s)", (lang) => {
  beforeEach(() => {
    mocks.lang = lang;
  });

  it("sends the account entry to the dashboard when signed in", async () => {
    await expect(AccountPage({ params: Promise.resolve({ lang }) })).rejects.toEqual(
      new Error(`redirect:/${lang}/dashboard`),
    );
  });

  it("uses the dashboard as the return destination from the account entry", async () => {
    mocks.getSession.mockResolvedValue(null);
    await expect(AccountPage({ params: Promise.resolve({ lang }) })).rejects.toEqual(
      new Error(
        `redirect:/${lang}/account/sign-in?returnUrl=${encodeURIComponent(`/${lang}/dashboard`)}`,
      ),
    );
  });

  const returnTargets = [
    { name: "no return URL", returnUrl: undefined, destination: `/${lang}/dashboard` },
    {
      name: "unsafe return URL",
      returnUrl: "https://evil.example/",
      destination: `/${lang}/dashboard`,
    },
    {
      name: "explicit settings URL",
      returnUrl: `/${lang}/dashboard/account/profile`,
      destination: `/${lang}/dashboard/account/profile`,
    },
    {
      name: "desktop continuation",
      returnUrl: `https://beutl.beditor.net/${lang}/account/native-auth/continue?returnUrl=http%3A%2F%2Flocalhost%3A43123%2Fcallback`,
      destination: `/${lang}/account/native-auth/continue?returnUrl=http%3A%2F%2Flocalhost%3A43123%2Fcallback`,
    },
  ];

  for (const [flow, Page, action] of [
    ["sign-in", SignInPage, signInWithEmailAction],
    ["sign-up", SignUpPage, signUpWithEmailAction],
  ] as const) {
    it.each(returnTargets)(
      `${flow} redirects an existing session with $name`,
      async ({ returnUrl, destination }) => {
        await expect(
          Page({
            params: Promise.resolve({ lang }),
            searchParams: Promise.resolve({ returnUrl }),
          }),
        ).rejects.toEqual(new Error(`redirect:${destination}`));
      },
    );

    it.each(returnTargets)(
      `${flow} sets the magic-link destination with $name`,
      async ({ returnUrl, destination }) => {
        const form = new FormData();
        form.set("email", "user@example.com");
        if (returnUrl !== undefined) form.set("returnUrl", returnUrl);

        await expect(action({}, form)).rejects.toEqual(
          new Error(`redirect:/${lang}/account/verify-request`),
        );
        expect(mocks.signInMagicLink).toHaveBeenCalledWith({
          body: {
            email: "user@example.com",
            callbackURL: destination,
            errorCallbackURL: "/account/error",
          },
          headers: expect.any(Headers),
        });
      },
    );
  }
});
