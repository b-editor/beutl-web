import { describe, expect, it } from "vitest";
import { resolveContentAccess } from "@beutl/core";
import { contentCacheHeaders } from "../../apps/web/src/lib/content-cache";

describe("authenticated content caching", () => {
  it("never stores private content in a reusable browser cache", () => {
    expect(contentCacheHeaders(false)).toEqual({
      "Cache-Control": "no-store",
      Vary: "Cookie, Authorization",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
    });
  });

  it("requires public content to be revalidated before every reuse", () => {
    expect(contentCacheHeaders(true)).toEqual({
      "Cache-Control": "public, no-cache, must-revalidate",
      Vary: "Cookie, Authorization",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
    });
  });

  it("does not treat an empty Profile relation as public content", async () => {
    await expect(
      resolveContentAccess({
        file: dedicatedFile(),
        userId: "other-user",
        hasPurchasedPackage: async () => false,
      }),
    ).resolves.toEqual({ outcome: "denied" });
  });

  it("allows an orphaned dedicated file owner without public caching", async () => {
    await expect(
      resolveContentAccess({
        file: dedicatedFile(),
        userId: "owner",
        hasPurchasedPackage: async () => false,
      }),
    ).resolves.toEqual({ outcome: "allowed", canUsePublicCache: false });
  });

  it("keeps actual profile content public", async () => {
    await expect(
      resolveContentAccess({
        file: dedicatedFile({ Profile: [{}] }),
        userId: null,
        hasPurchasedPackage: async () => false,
      }),
    ).resolves.toEqual({ outcome: "allowed", canUsePublicCache: true });
  });

  it("allows a free release anonymously without public caching", async () => {
    const access = await resolveContentAccess({
      file: freeReleaseFile(),
      userId: null,
      hasPurchasedPackage: async () => false,
    });

    expect(access).toEqual({
      outcome: "allowed",
      canUsePublicCache: false,
    });
    expect(
      contentCacheHeaders(
        access.outcome === "allowed" && access.canUsePublicCache,
      ),
    ).toEqual({
      "Cache-Control": "no-store",
      Vary: "Cookie, Authorization",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
    });
  });

  it("allows an all-zero-priced release without a payment record", async () => {
    let paymentChecks = 0;
    await expect(
      resolveContentAccess({
        file: releaseFile([{ id: "zero-price", price: 0 }]),
        userId: null,
        hasPurchasedPackage: async () => {
          paymentChecks++;
          return false;
        },
      }),
    ).resolves.toEqual({ outcome: "allowed", canUsePublicCache: false });
    expect(paymentChecks).toBe(0);
  });

  it("does not publicly cache an explicitly public release payload", async () => {
    await expect(
      resolveContentAccess({
        file: freeReleaseFile({ visibility: "PUBLIC" }),
        userId: null,
        hasPurchasedPackage: async () => false,
      }),
    ).resolves.toEqual({
      outcome: "allowed",
      canUsePublicCache: false,
    });
  });

  it("requires payment for an explicitly public paid release", async () => {
    await expect(
      resolveContentAccess({
        file: paidReleaseFile({ visibility: "PUBLIC" }),
        userId: null,
        hasPurchasedPackage: async () => false,
      }),
    ).resolves.toEqual({ outcome: "payment-required" });
  });

  it("requires payment when a paid release has a public package relation", async () => {
    await expect(
      resolveContentAccess({
        file: paidReleaseFile({
          Package: [{ userId: "owner", published: true }],
        }),
        userId: null,
        hasPurchasedPackage: async () => false,
      }),
    ).resolves.toEqual({ outcome: "payment-required" });
  });

  it("allows a paid release owner without a purchase record", async () => {
    let paymentChecks = 0;
    await expect(
      resolveContentAccess({
        file: paidReleaseFile(),
        userId: "owner",
        hasPurchasedPackage: async () => {
          paymentChecks++;
          return false;
        },
      }),
    ).resolves.toEqual({ outcome: "allowed", canUsePublicCache: false });
    expect(paymentChecks).toBe(0);
  });

  it("allows purchasers while keeping paid content private", async () => {
    await expect(
      resolveContentAccess({
        file: paidReleaseFile(),
        userId: "purchaser",
        hasPurchasedPackage: async (packageId) => packageId === "package-1",
      }),
    ).resolves.toEqual({ outcome: "allowed", canUsePublicCache: false });
  });

  it("requires payment for an unpaid published release", async () => {
    await expect(
      resolveContentAccess({
        file: paidReleaseFile(),
        userId: "other-user",
        hasPurchasedPackage: async () => false,
      }),
    ).resolves.toEqual({ outcome: "payment-required" });
  });
});

function dedicatedFile(overrides: Record<string, unknown> = {}) {
  return {
    visibility: "DEDICATED" as const,
    userId: "owner",
    Package: [],
    Profile: [],
    PackageScreenshot: [],
    Release: [],
    ...overrides,
  };
}

function paidReleaseFile(overrides: Record<string, unknown> = {}) {
  return releaseFile([{ id: "price-1", price: 100 }], overrides);
}

function freeReleaseFile(overrides: Record<string, unknown> = {}) {
  return releaseFile([], overrides);
}

function releaseFile(
  packagePricing: Array<{ id: string; price: number }>,
  overrides: Record<string, unknown> = {},
) {
  return dedicatedFile({
    Release: [
      {
        published: true,
        package: {
          id: "package-1",
          userId: "owner",
          published: true,
          packagePricing,
        },
      },
    ],
    ...overrides,
  });
}
