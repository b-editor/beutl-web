import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "../../apps/web/node_modules/react-dom/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), limit: vi.fn(), customer: vi.fn(), stripe: vi.fn(),
  owned: vi.fn(), package: vi.fn(), currency: vi.fn(), prices: vi.fn(),
}));
vi.mock("@/lib/auth-guard", () => ({ authOrSignIn: mocks.auth }));
vi.mock("@/lib/package-checkout-rate-limit", () => ({ consumePackageCheckoutLimit: mocks.limit }));
vi.mock("@/lib/stripe/customer", () => ({ createOrRetrieveOwnedCustomerId: mocks.customer }));
vi.mock("@/lib/stripe/config", () => ({ createStripe: mocks.stripe }));
vi.mock("@/lib/store-utils", () => ({
  packageOwned: mocks.owned, retrievePackage: mocks.package, retrievePrices: mocks.prices,
}));
vi.mock("@/lib/currency", () => ({ guessCurrency: mocks.currency }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "cf-connecting-ip": "203.0.113.1" }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw new Error(`redirect:${url}`); },
  notFound: () => { throw new Error("not-found"); },
}));

import Page from "../../apps/web/src/app/[lang]/(store)/store/[name]/checkout/page";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "owner", email: "owner@example.com" } });
  mocks.package.mockResolvedValue({ id: "pkg-1", name: "example" });
  mocks.owned.mockResolvedValue(false);
  mocks.limit.mockResolvedValue({ allowed: false, retryAfter: 42 });
  mocks.currency.mockResolvedValue("USD");
  mocks.prices.mockResolvedValue([{ price: 500, currency: "USD", fallback: true }]);
});

describe("store checkout admission", () => {
  it.each(["en", "ja"])("renders a localized wait message before Stripe work (%s)", async (lang) => {
    const markup = renderToStaticMarkup(await Page({ params: Promise.resolve({ lang, name: "example" }) }));
    expect(markup).toContain('role="alert"');
    expect(markup).toContain(lang === "en" ? "Please wait 42 seconds" : "42秒待って");
    expect(markup).toContain(`href="/${lang}/store/example"`);
    expect(mocks.limit).toHaveBeenCalledWith("owner", expect.any(Headers));
    expect(mocks.customer).not.toHaveBeenCalled();
    expect(mocks.stripe).not.toHaveBeenCalled();
    expect(mocks.currency).not.toHaveBeenCalled();
  });

  it("continues the existing checkout flow when admitted", async () => {
    mocks.limit.mockResolvedValue({ allowed: true });
    mocks.customer.mockRejectedValue(new Error("customer-step"));
    await expect(Page({ params: Promise.resolve({ lang: "en", name: "example" }) }))
      .rejects.toThrow("customer-step");
    expect(mocks.customer).toHaveBeenCalledWith({ userId: "owner", email: "owner@example.com" });
  });

  it("does not contact Stripe when admission storage fails", async () => {
    mocks.limit.mockRejectedValue(new Error("database unavailable"));
    await expect(Page({ params: Promise.resolve({ lang: "en", name: "example" }) }))
      .rejects.toThrow("database unavailable");
    expect(mocks.customer).not.toHaveBeenCalled();
    expect(mocks.stripe).not.toHaveBeenCalled();
  });

  it("does not consume checkout quota for an owned package", async () => {
    mocks.owned.mockResolvedValue(true);
    await expect(Page({ params: Promise.resolve({ lang: "en", name: "example" }) }))
      .rejects.toThrow("redirect:/store/example");
    expect(mocks.limit).not.toHaveBeenCalled();
    expect(mocks.customer).not.toHaveBeenCalled();
  });

  it("requires authentication before consuming checkout quota", async () => {
    mocks.auth.mockRejectedValue(new Error("redirect:/account/sign-in"));
    await expect(Page({ params: Promise.resolve({ lang: "en", name: "example" }) }))
      .rejects.toThrow("redirect:/account/sign-in");
    expect(mocks.limit).not.toHaveBeenCalled();
    expect(mocks.customer).not.toHaveBeenCalled();
  });
});
