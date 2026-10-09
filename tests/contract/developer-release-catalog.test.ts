import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  retrievePackage: vi.fn(),
  findVersions: vi.fn(),
  releaseForm: vi.fn(),
}));

vi.mock("@/lib/auth-guard", () => ({
  throwIfUnauth: async () => ({ user: { id: "owner" } }),
}));
vi.mock("@beutl/db", () => ({ findAppReleaseAssetVersions: mocks.findVersions }));
vi.mock("../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/actions/package", () => ({ retrievePackage: mocks.retrievePackage }));
vi.mock("../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/screenshot-form", () => ({ ScreenshotForm: () => null }));
vi.mock("../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/package-info-form", () => ({ PackageInfoForm: () => null }));
vi.mock("../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/package-description-form", () => ({ PackageDescriptionForm: () => null }));
vi.mock("../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/package-details-form", () => ({ PackageDetailsForm: () => null }));
vi.mock("../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/package-pricing-form", () => ({ PackagePricingForm: () => null }));
vi.mock("../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/release-form", () => ({ ReleaseForm: mocks.releaseForm }));

import Page from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/page";

const appRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { renderToStaticMarkup } = appRequire("react-dom/server");
const pkg = { id: "package-1" };
const params = () => Promise.resolve({ lang: "en", name: "package" });

describe("developer release version catalog", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.retrievePackage.mockResolvedValue(pkg);
    mocks.findVersions.mockResolvedValue([]);
    mocks.releaseForm.mockReturnValue(null);
  });

  afterEach(() => vi.restoreAllMocks());

  it("renders the release editor with no suggestions when the optional catalog fails", async () => {
    const error = new Error("release asset query failed");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.findVersions.mockRejectedValue(error);

    renderToStaticMarkup(await Page({ params: params() }));

    expect(mocks.releaseForm).toHaveBeenCalledWith(
      { pkg, lang: "en", beutlVersions: [] },
      undefined,
    );
    expect(log).toHaveBeenCalledWith("Failed to load Beutl version suggestions", error);
  });

  it("keeps valid versions unique and in semantic descending order", async () => {
    mocks.findVersions.mockResolvedValue([
      { version: "2.0.0-preview.9" },
      { version: "1.9.0" },
      { version: "v2.0.0" },
      { version: "invalid" },
      { version: "2.0.0-preview.10" },
      { version: "2.0.0" },
    ]);

    renderToStaticMarkup(await Page({ params: params() }));

    expect(mocks.releaseForm).toHaveBeenCalledWith(
      { pkg, lang: "en", beutlVersions: ["2.0.0", "2.0.0-preview.10", "2.0.0-preview.9", "1.9.0"] },
      undefined,
    );
  });

  it("still propagates failures from the required package lookup", async () => {
    const error = new Error("package query failed");
    mocks.retrievePackage.mockRejectedValue(error);

    await expect(Page({ params: params() })).rejects.toBe(error);
    expect(mocks.findVersions).not.toHaveBeenCalled();
  });
});
