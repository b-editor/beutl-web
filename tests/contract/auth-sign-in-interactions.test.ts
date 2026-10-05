// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "../../apps/web/node_modules/react";
import { createRoot, type Root } from "../../apps/web/node_modules/react-dom/client";

const mocks = vi.hoisted(() => ({
  social: vi.fn(),
  passkey: vi.fn(),
  push: vi.fn(),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: { signIn: { social: mocks.social, passkey: mocks.passkey } },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@beutl/ui/i18n-client", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@beutl/ui/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("../../apps/web/src/app/[lang]/(auth-flow)/account/sign-in/actions", () => ({
  signInWithEmailAction: async () => ({}),
}));

import SignInForm from "../../apps/web/src/app/[lang]/(auth-flow)/account/sign-in/form";

describe("sign-in redirect interactions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.social.mockResolvedValue({});
    mocks.passkey.mockResolvedValue({});
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  for (const lang of ["ja", "en"]) {
    const returnTargets = [
      { name: "no return URL", returnUrl: undefined, destination: `/${lang}/dashboard` },
      {
        name: "unsafe return URL",
        returnUrl: "https://evil.example/",
        destination: `/${lang}/dashboard`,
      },
      {
        name: "explicit return URL",
        returnUrl: `/${lang}/dashboard/account/profile`,
        destination: `/${lang}/dashboard/account/profile`,
      },
    ];

    for (const [index, provider] of ["google", "github", "passkey"].entries()) {
      it.each(returnTargets)(
        `${provider} (${lang}) honors $name`,
        async ({ returnUrl, destination }) => {
          await act(() =>
            root.render(createElement(SignInForm, { lang, returnUrl, legalLinks: null })),
          );
          const button =
            container.querySelectorAll<HTMLButtonElement>('button[type="button"]')[index];
          await act(() => button.click());

          if (provider === "passkey") {
            expect(mocks.passkey).toHaveBeenCalledOnce();
            expect(mocks.push).toHaveBeenCalledWith(destination);
          } else {
            expect(mocks.social).toHaveBeenCalledWith({ provider, callbackURL: destination });
          }
        },
      );
    }
  }
});
