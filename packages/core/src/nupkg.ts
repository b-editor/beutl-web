// Builds a NuGet package (.nupkg) from a payload directory. The desktop client
// installs data packages through the NuGet pipeline, so the zip has to carry a root
// nuspec plus the payload under `materials/` or `templates/` — the layout
// `PackageFolderReader` reads after extraction.

import { strToU8, zipSync } from "fflate";

export type NupkgFile = {
  /** Path within the package, e.g. `materials/logo.png` or `templates/title.json`. */
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
    entries[path] = file.data;
  }

  return zipSync(entries);
}

function splitPath(path: string): string[] {
  return path.split("/").filter((s) => s !== "" && s !== ".");
}

function relativePath(fromDir: string, toPath: string): string {
  const from = splitPath(fromDir);
  const to = splitPath(toPath);
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) {
    common++;
  }
  const ups = from.length - common;
  const downs = to.slice(common);
  return [...Array(ups).fill(".."), ...downs].join("/");
}

/**
 * The URI a template file uses to reach a bundled material after installation.
 * The install layout is `{home}/templates/{package}/...` and
 * `{home}/materials/{package}/...`, so the `{home}` prefix cancels out of the
 * relative path and the result is portable across machines.
 */
export function materialReferenceUri(
  templatePackagePath: string,
  materialPackagePath: string,
  packageId: string,
): string {
  const subdir = splitPath(templatePackagePath).slice(0, -1).join("/").replace(/^templates\/?/, "");
  const templateDir = `templates/${packageId}${subdir ? `/${subdir}` : ""}`;
  const materialPath = `materials/${packageId}/${materialPackagePath.replace(/^materials\//, "")}`;
  return relativePath(templateDir, materialPath);
}

/**
 * Rewrites `file://` references in a template JSON that point at bundled
 * materials into URIs relative to the template file, so the reference survives
 * installation on another machine. Matching is by file name.
 */
export function rewriteTemplateReferences(
  json: string,
  templatePackagePath: string,
  materials: { packagePath: string; basename: string }[],
  packageId: string,
): string {
  const byBasename = new Map(
    materials.map((m) => [m.basename.toLowerCase(), m.packagePath]),
  );

  const rewrite = (node: unknown): unknown => {
    if (typeof node === "string") {
      if (node.startsWith("file://")) {
        const basename = decodeURIComponent(node.split("/").pop() ?? "").toLowerCase();
        const materialPath = byBasename.get(basename);
        if (materialPath) {
          return materialReferenceUri(templatePackagePath, materialPath, packageId);
        }
      }
      return node;
    }
    if (Array.isArray(node)) {
      return node.map(rewrite);
    }
    if (node !== null && typeof node === "object") {
      for (const key of Object.keys(node)) {
        (node as Record<string, unknown>)[key] = rewrite((node as Record<string, unknown>)[key]);
      }
    }
    return node;
  };

  return JSON.stringify(rewrite(JSON.parse(json)));
}
