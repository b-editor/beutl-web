import { describe, expect, it } from "vitest";
import { strToU8, unzipSync } from "fflate";
import {
  buildNupkg,
  buildNuspec,
  materialReferenceUri,
  rewriteTemplateReferences,
  sanitizePayloadPath,
} from "@beutl/core";

const OPTIONS = {
  id: "Beutl.Materials.tester.city-photos",
  version: "1.0.0",
  title: "City Photos",
  description: "Royalty-free city photography.",
  tags: ["beutl-material", "photography", "cc0"],
  authors: "tester",
  files: [
    { path: "materials/logo.png", data: strToU8("png") },
    { path: "materials/audio/sting.wav", data: strToU8("wav") },
  ],
};

describe("buildNuspec", () => {
  it("carries the package identity and the reserved kind tag", () => {
    const nuspec = buildNuspec(OPTIONS);

    expect(nuspec).toContain("<id>Beutl.Materials.tester.city-photos</id>");
    expect(nuspec).toContain("<version>1.0.0</version>");
    expect(nuspec).toContain("<tags>beutl-material photography cc0</tags>");
  });

  it("escapes XML metacharacters in free-text fields", () => {
    const nuspec = buildNuspec({
      ...OPTIONS,
      title: "A & B <C>",
      description: 'say "hi"',
    });

    expect(nuspec).toContain("<title>A &amp; B &lt;C&gt;</title>");
    expect(nuspec).toContain("<description>say &quot;hi&quot;</description>");
  });
});

describe("buildNupkg", () => {
  it("places the nuspec at the root and the payload under the content directory", () => {
    const zip = unzipSync(buildNupkg(OPTIONS));

    expect(Object.keys(zip).sort()).toEqual([
      "Beutl.Materials.tester.city-photos.1.0.0.nuspec",
      "materials/audio/sting.wav",
      "materials/logo.png",
    ]);
    expect(new TextDecoder().decode(zip["materials/logo.png"])).toBe("png");
  });

  it("packs templates under templates/", () => {
    const zip = unzipSync(
      buildNupkg({
        ...OPTIONS,
        files: [{ path: "templates/title.json", data: strToU8("{}") }],
      }),
    );

    expect(zip["templates/title.json"]).toBeDefined();
    expect(zip["materials/logo.png"]).toBeUndefined();
  });

  it("packs both payloads when the files carry both prefixes", () => {
    const zip = unzipSync(
      buildNupkg({
        ...OPTIONS,
        files: [
          { path: "materials/logo.png", data: strToU8("png") },
          { path: "templates/title.json", data: strToU8("{}") },
        ],
      }),
    );

    expect(zip["materials/logo.png"]).toBeDefined();
    expect(zip["templates/title.json"]).toBeDefined();
  });
});

describe("sanitizePayloadPath", () => {
  it("normalizes backslashes to forward slashes", () => {
    expect(sanitizePayloadPath("audio\\sting.wav")).toBe("audio/sting.wav");
  });

  it("rejects paths that escape the package", () => {
    for (const bad of ["../evil.png", "a/../../evil.png", "/abs.png", "a:\\evil.png", "a//b.png"]) {
      expect(() => sanitizePayloadPath(bad)).toThrow();
    }
  });
});

describe("materialReferenceUri", () => {
  it("reaches a bundled material from a root template", () => {
    expect(
      materialReferenceUri("templates/title.json", "materials/logo.png", "pkg"),
    ).toBe("../../materials/pkg/logo.png");
  });

  it("reaches a bundled material from a nested template", () => {
    expect(
      materialReferenceUri("templates/lower-thirds/title.json", "materials/logo.png", "pkg"),
    ).toBe("../../../materials/pkg/logo.png");
  });

  // A raw `#` would make the rest of the name a fragment, so the installed
  // template could not resolve the material.
  it("percent-encodes characters a URI reads as syntax", () => {
    expect(
      materialReferenceUri("templates/title.json", "materials/logo#dark.png", "pkg"),
    ).toBe("../../materials/pkg/logo%23dark.png");
  });

  it("keeps the parent segments unescaped", () => {
    expect(
      materialReferenceUri("templates/title.json", "materials/a b.png", "pkg"),
    ).toBe("../../materials/pkg/a%20b.png");
  });
});

describe("rewriteTemplateReferences", () => {
  const materials = [{ packagePath: "materials/logo.png", basename: "logo.png" }];

  it("rewrites a file reference to a relative URI", () => {
    const json = JSON.stringify({
      Json: { source: "file:///Users/me/Photos/logo.png" },
    });

    const rewritten = rewriteTemplateReferences(json, "templates/title.json", materials, "pkg");

    expect(JSON.parse(rewritten).Json.source).toBe("../../materials/pkg/logo.png");
  });

  it("leaves references to files that are not bundled alone", () => {
    const json = JSON.stringify({
      Json: { source: "file:///Users/me/Photos/other.png" },
    });

    const rewritten = rewriteTemplateReferences(json, "templates/title.json", materials, "pkg");

    expect(JSON.parse(rewritten).Json.source).toBe("file:///Users/me/Photos/other.png");
  });
});
