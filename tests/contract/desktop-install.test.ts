import { describe, expect, it } from "vitest";
import { desktopInstallUrl } from "../../apps/web/src/lib/desktop-install";

describe("desktop install handoff", () => {
  it("passes the package name and selected version to Beutl", () => {
    expect(desktopInstallUrl("Beutl.Sample", "1.2.3")).toBe(
      "beutl://install?package=Beutl.Sample&version=1.2.3",
    );
  });

  it("preserves prerelease and build metadata without adding query parameters", () => {
    const url = new URL(desktopInstallUrl("Sample&version=other", "1.2.3-preview.1+build.5"));
    expect(url.searchParams.get("package")).toBe("Sample&version=other");
    expect(url.searchParams.getAll("version")).toEqual(["1.2.3-preview.1+build.5"]);
  });
});
