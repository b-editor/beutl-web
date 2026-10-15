import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { compareNugetVersions, normalizeNugetId, normalizeNugetVersion } from "@beutl/core";
import { blobReader, parseNuspec, readNugetPackage } from "../../packages/api/src/nuget/archive";
import { readPushBody, NUGET_PUSH_LIMIT } from "../../packages/api/src/nuget/push";

const nuspec = `<package><metadata><id>Sample.Library</id><version>01.2.0.0-Beta.2+build</version><authors>123</authors><description>A library</description><readme>README.md</readme><dependencies><group targetFramework="net10.0"><dependency id="Another.Lib" version="[1.0,2.0)" /></group></dependencies></metadata></package>`;
function archive(manifest = nuspec) { return new Blob([zipSync({ "Sample.Library.nuspec": strToU8(manifest), "README.md": strToU8("# Library"), "lib/net10.0/sample.dll": new Uint8Array(1024) })]); }

describe("NuGet package identities and metadata", () => {
  it("treats case, build metadata, padded numbers and zero revisions as the same identity", () => {
    expect(normalizeNugetId("Sample.Library")).toBe("sample.library");
    expect(normalizeNugetVersion("01.2.0.0-Beta.2+build")).toBe("1.2.0-beta.2");
    expect(normalizeNugetVersion("1.2")).toBe("1.2.0");
    expect(normalizeNugetVersion("1.2.0.4")).toBe("1.2.0.4");
    expect(() => normalizeNugetVersion("2147483648.0.0")).toThrow();
    expect(() => normalizeNugetId("../other")).toThrow();
  });
  it("sorts revisions, stable versions and numeric prerelease identifiers as NuGet versions", () => {
    expect(["1.0.0-beta.10", "1.0.0.2", "1.0.0", "1.0.0-beta.9"].sort(compareNugetVersions))
      .toEqual(["1.0.0-beta.9", "1.0.0-beta.10", "1.0.0", "1.0.0.2"]);
    expect(compareNugetVersions("1.0.0-beta-x.2", "1.0.0-beta-x.10")).toBeLessThan(0);
  });
  it("reads the nuspec, framework groups and declared readme without changing numeric text", async () => {
    const parsed = await readNugetPackage(blobReader(archive()), { id: "sample.library", version: "1.2.0-beta.2" });
    expect(parsed.metadata).toMatchObject({ id: "Sample.Library", authors: "123", dependencyGroups: [{ targetFramework: "net10.0", dependencies: [{ id: "Another.Lib", range: "[1.0,2.0)" }] }] });
    expect(parsed.readme).toBe("# Library");
  });
  it("rejects mismatched identities and missing declared assets before storing an artifact", async () => {
    await expect(readNugetPackage(blobReader(archive()), { id: "Other", version: "1.2.0-beta.2" })).rejects.toThrow("match");
    await expect(readNugetPackage(blobReader(archive(nuspec.replace("README.md", "missing.md"))))).rejects.toThrow("readme is missing");
    expect(() => parseNuspec('<!DOCTYPE package [<!ENTITY bomb "boom">]>' + nuspec)).toThrow("Invalid package manifest");
  });
  it("rejects duplicate root manifests and oversized metadata", async () => {
    const two = new Blob([zipSync({ "one.nuspec": strToU8(nuspec), "two.nuspec": strToU8(nuspec) })]);
    await expect(readNugetPackage(blobReader(two))).rejects.toThrow("one root");
    const big = new Blob([zipSync({ "one.nuspec": strToU8(nuspec), "README.md": new Uint8Array(2 * 1024 * 1024 + 1) })]);
    await expect(readNugetPackage(blobReader(big))).rejects.toThrow("too large");
  });
});

describe("NuGet push wire format", () => {
  it("uses the first part regardless of its field name, filename or extra parts", async () => {
    const body = new Blob(['--abc\r\nContent-Disposition: form-data; name=anything\r\n\r\n', archive(), '\r\n--abc\r\nContent-Disposition: form-data; name=extra\r\n\r\nignored\r\n--abc--\r\n']);
    const file = await readPushBody(new Request("https://nuget.test/api/v2/package", { method: "PUT", headers: { "content-type": "multipart/form-data; boundary=abc" }, body }));
    expect(await file.arrayBuffer()).toEqual(await archive().arrayBuffer());
  });
  it("accepts raw packages and refuses an oversized declared body", async () => {
    expect((await readPushBody(new Request("https://nuget.test", { method: "PUT", body: archive() }))).size).toBe(archive().size);
    await expect(readPushBody(new Request("https://nuget.test", { method: "PUT", headers: { "content-length": String(NUGET_PUSH_LIMIT + 65537) }, body: "x" }))).rejects.toThrow();
  });
});
