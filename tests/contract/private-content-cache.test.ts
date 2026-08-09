import { describe, expect, it } from "vitest";
import { resolveContentAccess } from "@beutl/core";
import { contentCacheHeaders } from "../../apps/web/src/lib/content-cache";

describe("authenticated content caching", () => {
  it("never stores private content in a reusable browser cache", () => {
    expect(contentCacheHeaders(false)).toEqual({
      "Cache-Control": "no-store",
      Vary: "Cookie, Authorization",
    });
  });

  it("keeps explicitly public content immutable", () => {
    expect(contentCacheHeaders(true)).toEqual({
      "Cache-Control": "public, max-age=31536000, immutable",
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

  it("keeps actual profile content public", async () => {
    await expect(
      resolveContentAccess({
        file: dedicatedFile({ Profile: [{}] }),
        userId: null,
        hasPurchasedPackage: async () => false,
      }),
    ).resolves.toEqual({ outcome: "allowed", isPublic: true });
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
    ).resolves.toEqual({ outcome: "allowed", isPublic: false });
    expect(paymentChecks).toBe(0);
  });

  it("allows purchasers while keeping paid content private", async () => {
    await expect(
      resolveContentAccess({
        file: paidReleaseFile(),
        userId: "purchaser",
        hasPurchasedPackage: async (packageId) => packageId === "package-1",
      }),
    ).resolves.toEqual({ outcome: "allowed", isPublic: false });
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

function paidReleaseFile() {
  return dedicatedFile({
    Release: [
      {
        published: true,
        package: {
          id: "package-1",
          userId: "owner",
          published: true,
          packagePricing: [{ id: "price-1" }],
        },
      },
    ],
  });
}
