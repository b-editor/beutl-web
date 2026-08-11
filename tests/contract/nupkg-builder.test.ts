import { describe, expect, it } from "vitest";
import { strToU8, unzipSync } from "fflate";
import {
  buildNupkg,
  buildNuspec,
  sanitizePayloadPath,
} from "@beutl/core";

const OPTIONS = {
  id: "Beutl.Materials.tester.city-photos",
  version: "1.0.0",
  title: "City Photos",
  description: "Royalty-free city photography.",
  tags: ["beutl-material", "photography", "cc0"],
  authors: "tester",
  contentDir: "materials" as const,
  files: [
    { path: "logo.png", data: strToU8("png") },
    { path: "audio/sting.wav", data: strToU8("wav") },
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
        contentDir: "templates",
        files: [{ path: "title.json", data: strToU8("{}") }],
      }),
    );

    expect(zip["templates/title.json"]).toBeDefined();
    expect(zip["materials/logo.png"]).toBeUndefined();
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
