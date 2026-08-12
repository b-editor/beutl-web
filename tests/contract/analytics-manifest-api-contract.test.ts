import { describe, expect, it } from "vitest";
import {
  resolveFileApprovedAnalyticsManifestSha256,
  toMarketplaceReleaseResponse,
} from "@beutl/api/v3/release-response";

const release = {
  id: "release-1",
  version: "1.0.0",
  title: "Release",
  description: "Description",
  targetVersion: "1.0.0",
  fileId: "file-1",
};

describe("analytics manifest API contract", () => {
  it("normalizes a legacy release to explicit nullable digest fields", async () => {
    await expect(
      toMarketplaceReleaseResponse(
        release,
        undefined,
        async () => "https://example.test/api/contents/file-1",
      ),
    ).resolves.toMatchObject({
      fileId: "file-1",
      packageSha256: null,
      approvedAnalyticsManifestSha256: null,
    });
  });

  it("returns file identity and matching package/manifest digests together", async () => {
    const response = await toMarketplaceReleaseResponse(
      {
        ...release,
        packageSha256: "package-sha256",
        approvedAnalyticsManifestSha256: "approved-manifest-sha256",
        file: {
          id: "file-1",
          sha256: "package-sha256",
        },
      },
      undefined,
      async () => "https://example.test/api/contents/file-1",
    );

    expect(response).toMatchObject({
      fileId: "file-1",
      packageSha256: "package-sha256",
      approvedAnalyticsManifestSha256: "approved-manifest-sha256",
    });
  });

  it("fails closed when the selected file and attestation do not match", async () => {
    const response = await toMarketplaceReleaseResponse(
      {
        ...release,
        packageSha256: "old-package-sha256",
        approvedAnalyticsManifestSha256: "stale-manifest-sha256",
        file: {
          id: "file-1",
          sha256: "replacement-package-sha256",
        },
      },
      undefined,
      async () => "https://example.test/api/contents/file-1",
    );

    expect(response).toMatchObject({
      fileId: "file-1",
      packageSha256: "replacement-package-sha256",
      approvedAnalyticsManifestSha256: null,
    });
  });

  it("does not infer a file approval from inconsistent release links", () => {
    expect(
      resolveFileApprovedAnalyticsManifestSha256("package-sha256", [
        {
          packageSha256: "package-sha256",
          approvedAnalyticsManifestSha256: "approved-a",
        },
        {
          packageSha256: "other-package-sha256",
          approvedAnalyticsManifestSha256: "approved-a",
        },
      ]),
    ).toBeNull();
    expect(
      resolveFileApprovedAnalyticsManifestSha256("package-sha256", [
        {
          packageSha256: "package-sha256",
          approvedAnalyticsManifestSha256: "approved-a",
        },
        {
          packageSha256: "package-sha256",
          approvedAnalyticsManifestSha256: "approved-a",
        },
      ]),
    ).toBe("approved-a");
  });
});
