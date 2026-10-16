import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { compareNugetVersions, isValidNugetVersion, normalizeNugetId, normalizeNugetVersion, requiresNugetSemVer2 } from "@beutl/core";
import { blobReader, parseNuspec, readNugetPackage } from "../../packages/api/src/nuget/archive";
import { readPushBody, NUGET_PUSH_LIMIT } from "../../packages/api/src/nuget/push";

const nuspec = `<package><metadata><id>Sample.Library</id><version>01.2.0.0-Beta.2+build</version><authors>123</authors><description>A library</description><readme>README.md</readme><dependencies><group targetFramework="net10.0"><dependency id="Another.Lib" version="[1.0,2.0)" /></group></dependencies></metadata></package>`;
function archive(manifest: string | Uint8Array = nuspec) { return new Blob([zipSync({ "Sample.Library.nuspec": typeof manifest === "string" ? strToU8(manifest) : manifest, "README.md": strToU8("# Library"), "lib/net10.0/sample.dll": new Uint8Array(1024) })]); }

describe("NuGet package identities and metadata", () => {
  it.each([
    [undefined, false], ["true", true], ["false", false], ["1", true], ["0", false], [" 1 ", true],
  ])("preserves XML license acceptance boolean %s", async (value, expected) => {
    const manifest = value === undefined ? nuspec : nuspec.replace("</metadata>", `<requireLicenseAcceptance>${value}</requireLicenseAcceptance></metadata>`);
    await expect(readNugetPackage(blobReader(archive(manifest)))).resolves.toHaveProperty("metadata.requireLicenseAcceptance", expected);
  });
  it.each(["", " ", "TRUE", "False", "yes", "2"])("rejects invalid XML license acceptance boolean %s", (value) => {
    expect(() => parseNuspec(nuspec.replace("</metadata>", `<requireLicenseAcceptance>${value}</requireLicenseAcceptance></metadata>`)))
      .toThrow("Invalid requireLicenseAcceptance boolean");
  });
  it.each(["<group />", '<group targetFramework="net10.0"><dependency id="Grouped" version="1.0" /></group>'])(
    "rejects flat dependencies mixed with %s", async (group) => {
      const manifest = nuspec.replace(/<dependencies>.*<\/dependencies>/u, `<dependencies><dependency id="Flat" version="1.0" />${group}</dependencies>`);
      await expect(readNugetPackage(blobReader(archive(manifest)))).rejects.toThrow("Cannot mix flat and grouped");
    },
  );
  it.each([
    "net10.0", "net8.0-windows10.0.19041.0", "net8.0-android35.0", "net8.0-ios", "netstandard2.0", "net481",
    ".NETFramework4.8", ".NETFramework,Version=v4.8,Profile=Client", ".NETCoreApp,Version=v10.0", "netcoreapp3.1",
    "net45-client", "native", "monoandroid10.0", "uap10.0", "portable-net45+win8", "portable-Profile259",
    ".NETPortable,Version=v4.5,Profile=Profile259", "Custom,Version=v1.0", "any", "agnostic", "net%38.0",
  ])("accepts NuGet target framework %s", (targetFramework) => {
    expect(parseNuspec(nuspec.replace('targetFramework="net10.0"', `targetFramework="${targetFramework}"`)).dependencyGroups[0].targetFramework)
      .toBe(targetFramework);
  });
  it.each([
    "not-a-framework", "", "unsupported", "net8.0-", "net8.0.0.0.0", "net2147483648.0", "net8.0-windows10.bad",
    "net8.0-windows2147483648", "portable", "portable-net45-client+win8", "Custom,Version=bad",
  ])("rejects unsupported NuGet target framework %s", async (targetFramework) => {
    const manifest = nuspec.replace('targetFramework="net10.0"', `targetFramework="${targetFramework}"`);
    await expect(readNugetPackage(blobReader(archive(manifest)))).rejects.toThrow("Invalid dependency target framework");
  });
  it("accepts flat dependencies and groups without a target framework separately", () => {
    const flat = nuspec.replace(/<group[^>]*>(.*)<\/group>/u, "$1");
    const grouped = nuspec.replace(' targetFramework="net10.0"', "");
    expect(parseNuspec(flat).dependencyGroups).toEqual(parseNuspec(grouped).dependencyGroups);
    expect(parseNuspec(grouped).dependencyGroups[0].targetFramework).toBe("");
  });
  it.each([
    ["LICENSE.txt", "LICENSE.txt"], ["licenses/LICENSE.MD", "licenses/LICENSE.MD"],
    ["LICENSE", "LICENSE"], ["licenses\\LICENSE.txt", "licenses/LICENSE.txt"],
    ["/LICENSE.txt", "LICENSE.txt"],
  ])("accepts the embedded license %s with matching ZIP casing", async (path, entry) => {
    const manifest = nuspec.replace("</metadata>", `<license type="file">${path}</license></metadata>`);
    const bytes = zipSync({ "Sample.Library.nuspec": strToU8(manifest), "README.md": strToU8("# SDK"), [entry]: strToU8("License terms") });
    await expect(readNugetPackage(blobReader(new Blob([bytes]))))
      .resolves.toHaveProperty("metadata", expect.objectContaining({ license: path, licenseType: "file" }));
  });
  it.each([
    ["LICENSE.txt", "other.txt"], ["LICENSE.txt", "license.txt"], ["licenses/LICENSE.txt", "Licenses/LICENSE.txt"],
    ["LICENSE.txt/", "LICENSE.txt/"], ["LICENSE.pdf", "LICENSE.pdf"],
  ])("rejects the license %s when the only archive entry is %s", async (path, entry) => {
    const manifest = nuspec.replace("</metadata>", `<license type="file">${path}</license></metadata>`);
    const bytes = zipSync({ "Sample.Library.nuspec": strToU8(manifest), "README.md": strToU8("# SDK"),
      [entry]: entry.endsWith("/") ? new Uint8Array() : strToU8("License terms") });
    await expect(readNugetPackage(blobReader(new Blob([bytes])))).rejects.toThrow(/license file/u);
  });
  it("preserves license expressions and legacy license URLs without requiring a file", async () => {
    const expression = nuspec.replace("</metadata>", '<license type="expression">MIT</license></metadata>');
    await expect(readNugetPackage(blobReader(archive(expression))))
      .resolves.toHaveProperty("metadata", expect.objectContaining({ license: "MIT", licenseType: "expression" }));
    const legacy = nuspec.replace("</metadata>", '<licenseUrl>https://example.test/license</licenseUrl></metadata>');
    const parsed = await readNugetPackage(blobReader(archive(legacy)));
    expect(parsed.metadata.licenseUrl).toBe("https://example.test/license");
    expect(parsed.metadata.licenseType).toBeUndefined();
  });
  it.each(['<license type="file" />', '<license type="unknown">MIT</license>', '<license>LICENSE.txt</license>'])(
    "rejects invalid license metadata %s", (license) => {
      expect(() => parseNuspec(nuspec.replace("</metadata>", `${license}</metadata>`))).toThrow("Invalid package license metadata");
    },
  );
  it.each([undefined, "1.2", "1.2.3", "1.2.3.4", "01.02", " +1 . 02 ", "0.-0", "1.2147483647"])(
    "accepts System.Version package type version %s", (version) => {
      const type = `<packageType name="Custom.Package_Type-1"${version === undefined ? "" : ` version="${version}"`} />`;
      expect(parseNuspec(nuspec.replace("</metadata>", `<packageTypes>${type}</packageTypes></metadata>`)).packageTypes)
        .toEqual([{ name: "Custom.Package_Type-1", version: version?.trim() ?? "" }]);
    },
  );
  it.each(["", " ", "1", "1.2.3.4.5", "not-a-version", "1.2-beta", "1.2+build", "1.-1", "1.2147483648", "1..2"])(
    "rejects package type version %s before accepting an archive", async (version) => {
      const manifest = nuspec.replace("</metadata>", `<packageTypes><packageType name="DotnetTool" version="${version}" /></packageTypes></metadata>`);
      await expect(readNugetPackage(blobReader(archive(manifest)))).rejects.toThrow("Invalid package type version");
    },
  );
  it.each([undefined, "", " ", ".type", "type..name", "type/name", "type name", "x".repeat(101)])(
    "rejects invalid package type name %s", (name) => {
      const type = `<packageType${name === undefined ? "" : ` name="${name}"`} />`;
      expect(() => parseNuspec(nuspec.replace("</metadata>", `<packageTypes>${type}</packageTypes></metadata>`)))
        .toThrow("Invalid package type name");
    },
  );
  it.each([
    "../../payload.dll", "lib/../../payload.dll", "lib/../payload.dll", "./payload.dll",
    "..\\payload.dll", "/payload.dll", "\\payload.dll", "//host/payload.dll", "C:/payload.dll", "C:payload.dll",
    "%2e%2e/payload.dll", "lib/%2E%2e%2fpayload.dll", "lib%2f..%5c..%5cpayload.dll",
    "%2fpayload.dll", "C%3a%5cpayload.dll", "lib/payload%00.dll",
  ])("rejects an unsafe ZIP entry %s even with a valid manifest", async (path) => {
    const bytes = zipSync({ "Sample.Library.nuspec": strToU8(nuspec), "README.md": strToU8("# SDK"), [path]: strToU8("payload") });
    await expect(readNugetPackage(blobReader(new Blob([bytes])))).rejects.toThrow("Unsafe package entry path");
  });
  it("allows ordinary NuGet paths and rejects decoded duplicate extraction paths", async () => {
    const files = { "Sample.Library.nuspec": strToU8(nuspec), "README.md": strToU8("# SDK"),
      "[Content_Types].xml": strToU8("types"), ".signature.p7s": strToU8("signature"),
      "lib/net10.0/": new Uint8Array(), "content/100%.txt": strToU8("percent"), "content/a%20b.txt": strToU8("space") };
    await expect(readNugetPackage(blobReader(new Blob([zipSync(files)])))).resolves.toHaveProperty("metadata.id", "Sample.Library");
    await expect(readNugetPackage(blobReader(new Blob([zipSync({ ...files, "CONTENT/a b.txt": strToU8("duplicate") })]))))
      .rejects.toThrow("Duplicate package entry");
  });
  it.each(["utf-8", "utf-16le", "utf-16be"])("decodes valid %s manifests and serves a UTF-8 declaration", async (encoding) => {
    const xml = `<?xml version="1.0" encoding="${encoding === "utf-8" ? encoding : "utf-16"}"?>${nuspec.replace("A library", "日本語のライブラリ")}`;
    const bytes = encoding === "utf-8" ? Buffer.from(xml) : Buffer.from(xml, "utf16le");
    if (encoding === "utf-16be") bytes.swap16();
    const bom = encoding === "utf-8" ? [0xef, 0xbb, 0xbf] : encoding === "utf-16le" ? [0xff, 0xfe] : [0xfe, 0xff];
    for (const content of [bytes, Buffer.concat([Buffer.from(bom), bytes])]) {
      const parsed = await readNugetPackage(blobReader(archive(content)));
      expect(parsed.metadata.description).toBe("日本語のライブラリ");
      expect(parsed.nuspec).toContain('encoding="utf-8"');
    }
  });
  it.each([false, true])("rejects malformed UTF-8 bytes (declared: %s)", async (declared) => {
    const xml = (declared ? '<?xml version="1.0" encoding="utf-8"?>' : "") + nuspec;
    const [before, after] = xml.split("A library");
    const bytes = Buffer.concat([Buffer.from(before), Buffer.from([0xc3, 0x28]), Buffer.from(after)]);
    await expect(readNugetPackage(blobReader(archive(bytes)))).rejects.toThrow("Invalid package manifest encoding");
  });
  it.each(["utf-16le", "utf-16be"])("rejects malformed %s code units", async (encoding) => {
    const xml = '<?xml version="1.0" encoding="utf-16"?>' + nuspec.replace("A library", "\ud800");
    const bytes = Buffer.from("\ufeff" + xml, "utf16le");
    if (encoding === "utf-16be") bytes.swap16();
    await expect(readNugetPackage(blobReader(archive(bytes)))).rejects.toThrow("Invalid package manifest encoding");
    await expect(readNugetPackage(blobReader(archive(bytes.subarray(0, bytes.length - 1))))).rejects.toThrow("Invalid package manifest encoding");
  });
  it.each(["utf-16", "shift_jis", "unknown"])("rejects a mismatched or unsupported %s declaration", async (encoding) => {
    await expect(readNugetPackage(blobReader(archive(`<?xml version="1.0" encoding="${encoding}"?>${nuspec}`))))
      .rejects.toThrow("Unsupported or mismatched package manifest encoding");
  });
  it.each(["1.0.0+linux-x64", "1.0.0-beta.1", "v1.0.0-beta.1+build"])("identifies SemVer 2 features in %s", (version) => {
    expect(requiresNugetSemVer2(version)).toBe(true);
  });
  it("classifies dependency range bounds independently", () => {
    for (const range of ["[1.0.0-beta.1,2.0.0)", "(,2.0.0+build]"]) {
      const metadata = parseNuspec(nuspec.replace("[1.0,2.0)", range).replace("01.2.0.0-Beta.2+build", "1.0.0"));
      expect(requiresNugetSemVer2("1.0.0", metadata)).toBe(true);
    }
    expect(requiresNugetSemVer2("1.0.0-beta")).toBe(false);
    const metadata = parseNuspec(nuspec.replace("[1.0,2.0)", "[1.0.0-beta,2.0.0)").replace("01.2.0.0-Beta.2+build", "1.0.0"));
    expect(requiresNugetSemVer2("1.0.0", metadata)).toBe(false);
  });
  it.each([
    "1", "1.0", "[1.0]", "(,1.0]", "(,1.0)", "(1.0,)", "[1.0,2.0)",
    "[1.0,1.0]", "(1.0,1.0)", "[,2.0]", "(, )", " [ 1.0 , 2.0 ) ",
    "[1.0.0-beta.1,2.0.0+build)", "1.2.3.4",
  ])("accepts NuGet dependency range %s", (range) => {
    expect(parseNuspec(nuspec.replace("[1.0,2.0)", range)).dependencyGroups[0].dependencies[0].range).toBe(range.trim());
  });
  it.each([
    "(1.0)", "[1.0)", "(1.0]", "(,)", "[]", "[,]", "", " ", "[2.0,1.0]",
    "[1.0,1.0)", "(1.0,1.0]", "[1.0,2.0,3.0]", "[1.0,2.0", "1.0,2.0",
    "latest", "^1.0", ">=1.0", "v1.0", "1.0.0-01", "[1.0,2.*)", "[*]",
    "1.*.0", "1.0.*-beta", "1.0.0+*", "**", "1.0.**", "1.0.0.0.*", "[2147483648.0,)",
    "*", "*-*", "1.*", "6.*", "1.0.*", "1.0.0.*", "1.0.0-*", "1.0.0-beta.*",
    "1.0.0-beta-*", "1.*-preview.*", "[1.*,2.0)",
  ])("rejects invalid NuGet dependency range %s", (range) => {
    expect(() => parseNuspec(nuspec.replace("[1.0,2.0)", range))).toThrow("Invalid dependency version range");
  });
  it("uses a NuGet-readable unbounded range when the dependency version is omitted", () => {
    expect(parseNuspec(nuspec.replace(' version="[1.0,2.0)"', "")).dependencyGroups[0].dependencies[0].range).toBe("(, )");
  });
  it.each([["title", 256], ["description", 4000], ["authors", 1024], ["summary", 4000], ["projectUrl", 2048]] as const)(
    "bounds %s before accepting an archive", async (field, limit) => {
      const manifest = (length: number) => `<package><metadata><id>Sample.Library</id><version>1.0.0</version>
        ${field !== "authors" ? "<authors>Author</authors>" : ""}${field !== "description" ? "<description>Library</description>" : ""}
        <${field}>${"x".repeat(length)}</${field}></metadata></package>`;
      expect(() => parseNuspec(manifest(limit))).not.toThrow();
      await expect(readNugetPackage(blobReader(archive(manifest(limit + 1))))).rejects.toThrow(`Package ${field} exceeds`);
    },
  );
  it("bounds tag lengths and count even within the manifest allowance", () => {
    const tags = (value: string) => nuspec.replace("</metadata>", `<tags>${value}</tags></metadata>`);
    expect(() => parseNuspec(tags(Array.from({ length: 50 }, (_, i) => `tag${i}`).join(" ")))).not.toThrow();
    expect(() => parseNuspec(tags(Array.from({ length: 51 }, (_, i) => `tag${i}`).join(" ")))).toThrow("tags exceed");
    expect(() => parseNuspec(tags("x".repeat(101)))).toThrow("tags exceed");
  });
  it("bounds dependency count and total serialized metadata", () => {
    const dependency = '<dependency id="Dependency" version="[1.0,2.0)" />';
    const manifest = nuspec.replace(/<dependencies>.*<\/dependencies>/u, `<dependencies>${dependency.repeat(1001)}</dependencies>`);
    expect(() => parseNuspec(manifest)).toThrow("Too many package dependencies");
    const large = nuspec.replace("</metadata>", `<releaseNotes>${"あ".repeat(30000)}</releaseNotes></metadata>`);
    expect(() => parseNuspec(large)).toThrow("exceeds 64 KiB");
  });
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
  it.each(["1.0.0-01", "1.0.0-alpha.01", "1.0.0-alpha.0.00", "1.0.0-01.alpha+build"])(
    "rejects leading zeroes in numeric prerelease components: %s", async (version) => {
      expect(isValidNugetVersion(version)).toBe(false);
      expect(() => normalizeNugetVersion(version)).toThrow("Invalid NuGet version");
      await expect(readNugetPackage(blobReader(archive(nuspec.replace("01.2.0.0-Beta.2+build", version)))))
        .rejects.toThrow("Invalid package ID or version");
    },
  );
  it.each(["1.0.0-alpha.0", "1.0.0-alpha.0a", "1.0.0-alpha.10+001.02", "1.0.0+01"])(
    "accepts zero, alphanumeric labels and padded build metadata: %s", (version) => {
      expect(isValidNugetVersion(version)).toBe(true);
      expect(() => parseNuspec(nuspec.replace("01.2.0.0-Beta.2+build", version))).not.toThrow();
    },
  );
  it("keeps legacy v-prefixed releases compatible with canonical identities", async () => {
    expect(normalizeNugetVersion("v1.2.0-Beta.2+linux-x64")).toBe("1.2.0-beta.2");
    expect(compareNugetVersions("v1.2.0+linux-x64", "1.2.0")).toBe(0);
    expect(isValidNugetVersion("v1.2.0")).toBe(true);
    expect(isValidNugetVersion("invalid")).toBe(false);
    await expect(readNugetPackage(blobReader(archive()), { id: "sample.library", version: "v1.2.0-Beta.2" }))
      .resolves.toHaveProperty("metadata.id", "Sample.Library");
    await expect(readNugetPackage(blobReader(archive(nuspec.replace("01.2.0.0-Beta.2+build", "v1.2.0-Beta.2")))))
      .rejects.toThrow("Invalid package ID or version");
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
