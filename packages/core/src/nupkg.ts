// Builds a NuGet package (.nupkg) from a payload directory. The desktop client
// installs data packages through the NuGet pipeline, so the zip has to carry a root
// nuspec plus the payload under `materials/` or `templates/` — the layout
// `PackageFolderReader` reads after extraction.

import { strToU8, zipSync } from "fflate";

export type NupkgFile = {
  /** Path within the payload directory, e.g. `logo.png` or `audio/sting.wav`. */
  path: string;
  data: Uint8Array;
};

export type NupkgOptions = {
  id: string;
  version: string;
  title: string;
  description: string;
  tags: string[];
  authors: string;
  /** The directory the payload is packed under. */
  contentDir: "materials" | "templates";
  files: NupkgFile[];
};

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildNuspec({
  id,
  version,
  title,
  description,
  tags,
  authors,
}: NupkgOptions): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">
  <metadata>
    <id>${escapeXml(id)}</id>
    <version>${escapeXml(version)}</version>
    <title>${escapeXml(title)}</title>
    <authors>${escapeXml(authors)}</authors>
    <description>${escapeXml(description)}</description>
    <tags>${escapeXml(tags.join(" "))}</tags>
  </metadata>
</package>
`;
}

/**
 * Sanitizes a payload-relative path so it cannot escape the package: no absolute
 * paths, no `..`, no backslashes, and no empty segments.
 */
export function sanitizePayloadPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    segments.some(
      (s) => s === "" || s === "." || s === ".." || s.includes(":"),
    )
  ) {
    throw new Error(`Invalid payload path: ${path}`);
  }
  return segments.join("/");
}

export function buildNupkg(options: NupkgOptions): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    [`${options.id}.${options.version}.nuspec`]: strToU8(buildNuspec(options)),
  };

  for (const file of options.files) {
    const path = sanitizePayloadPath(file.path);
    entries[`${options.contentDir}/${path}`] = file.data;
  }

  return zipSync(entries);
}
