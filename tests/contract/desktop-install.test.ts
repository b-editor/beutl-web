import { describe, expect, it } from "vitest";
import { desktopInstallUrl, desktopOpenRepositoryUrl } from "../../apps/web/src/lib/desktop-install";

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

describe("desktop repository handoff", () => {
  const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const base = `beutl://repo/open?id=${id}`;

  it("passes a repository UUID with no ref by default", () => {
    expect(desktopOpenRepositoryUrl(id)).toBe(base);
  });

  it("passes a selected branch", () => {
    expect(desktopOpenRepositoryUrl(id, "main")).toBe(`${base}&ref=main`);
  });

  it("preserves special characters in the ref as a single query value", () => {
    const ref = "refs/tags/夏&ref=other+#%";
    const href = desktopOpenRepositoryUrl(id, ref);
    expect(href).toBe(`${base}&ref=refs%2Ftags%2F%E5%A4%8F%26ref%3Dother%2B%23%25`);
    expect([...new URL(href).searchParams.entries()]).toEqual([["id", id], ["ref", ref]]);
  });

  it.each([null, "", "bad ref", "main?token=example", "x".repeat(256)])("omits an invalid or absent ref: %j", (ref) => {
    expect(desktopOpenRepositoryUrl(id, ref)).toBe(base);
  });

  it.each(["invalid", id.toUpperCase(), "00000000-0000-0000-0000-000000000000", `${id}&token=example`])(
    "rejects an invalid repository ID: %j",
    (invalidId) => {
      expect(() => desktopOpenRepositoryUrl(invalidId)).toThrow("Invalid Git repository ID");
    },
  );
});
